const { google } = require('googleapis');
const supabase = require('../services/supabaseClient');
const GoogleDriveService = require('../services/googleDriveService');
const fs = require('fs');
const path = require('path');

exports.googleLogin = (req, res) => {
    const oauth2Client = GoogleDriveService.getOAuth2Client();
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.metadata.readonly'
        ],
        prompt: 'consent'
    });
    res.redirect(url);
};

exports.verifyToken = async (req, res) => {
    const { idToken, email, serverAuthCode, forceAccountSync = false } = req.body;
    const client = GoogleDriveService.getOAuth2Client();

    try {
        // 1. Verify the ID token
        const ticket = await client.verifyIdToken({
            idToken: idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const verifiedEmail = payload['email'];

        if (verifiedEmail !== email) {
            return res.status(401).json({ error: 'Email mismatch' });
        }

        // 2. Ensure user exists in public.users
        let { data: existingUser } = await supabase
            .from('users')
            .select('id')
            .eq('email', verifiedEmail)
            .single();

        let authUserId;
        if (existingUser) {
            authUserId = existingUser.id;
        } else {
            const { data: newAuthUser, error: authError } = await supabase.auth.admin.createUser({
                email: verifiedEmail,
                email_confirm: true,
            });

            if (authError && authError.message.includes('already exists')) {
                const { data: { users } } = await supabase.auth.admin.listUsers();
                const matchedUser = users.find(u => u.email === verifiedEmail);
                authUserId = matchedUser.id;
            } else if (authError) {
                throw authError;
            } else {
                authUserId = newAuthUser.user.id;
            }
            await supabase.from('users').upsert({ id: authUserId, email: verifiedEmail });
        }

        const shouldSyncAccount = Boolean(serverAuthCode);

        console.log(`Storage sync decision -> serverCode:${Boolean(serverAuthCode)} => sync:${shouldSyncAccount}`);

        if (shouldSyncAccount) {
            const { tokens } = await client.getToken(serverAuthCode);
            client.setCredentials(tokens);
            
            const { quota } = await GoogleDriveService.getStorageQuota(tokens);
            console.log(`Quota retrieved: ${quota.usage} / ${quota.limit}`);

            const { error: accError } = await supabase.from('accounts').upsert({
                user_id: authUserId,
                email: verifiedEmail,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
                total_space: parseInt(quota.limit),
                used_space: parseInt(quota.usage)
            }, { onConflict: 'user_id, email' });

            if (accError) console.error('Account storage error:', accError);
            else console.log('Account stored successfully');
        } else {
            console.log('No serverAuthCode provided, skipping storage sync');
        }

        // Fetch final user record
        let { data: user, error: userError } = await supabase
            .from('users')
            .select('*')
            .eq('id', authUserId)
            .single();

        if (userError) throw userError;
        res.json({ message: 'Authentication successful', user });
    } catch (error) {
        console.error('Token verification error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
};

exports.getLinkUrl = (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).send('User ID required');

    const oauth2Client = GoogleDriveService.getOAuth2Client();
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.metadata.readonly'
        ],
        state: userId, // Pass userId in state to retrieve it in callback
        prompt: 'consent'
    });
    res.redirect(url);
};

exports.linkCallback = async (req, res) => {
    const { code, state: userId } = req.query;
    const client = GoogleDriveService.getOAuth2Client();

    try {
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: client });
        const userInfo = await oauth2.userinfo.get();
        const email = userInfo.data.email;

        const { quota } = await GoogleDriveService.getStorageQuota(tokens);

        console.log('--- MASTER ACCOUNT TOKEN GENERATED ---');
        console.log(`Refresh Token: ${tokens.refresh_token}`);
        console.log('Auto-updating backend .env MASTER_REFRESH_TOKEN entry.');
        console.log('---------------------------------------');

        try {
            updateMasterRefreshToken(tokens.refresh_token);
            process.env.MASTER_REFRESH_TOKEN = tokens.refresh_token;
        } catch (envErr) {
            console.error('Failed to persist MASTER_REFRESH_TOKEN to .env:', envErr.message);
        }

        // Try to save to accounts table, but don't fail if it's just meant for master token generation
        try {
            const { error: accError } = await supabase.from('accounts').upsert({
                user_id: userId,
                email: email,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expiry_date: new Date(tokens.expiry_date).toISOString(),
                total_space: parseInt(quota.limit),
                used_space: parseInt(quota.usage)
            }, { onConflict: 'user_id, email' });

            if (accError) {
              console.warn('Database Sync Warning:', accError.message);
              // If it's a foreign key error, it just means the userId in the URL doesn't exist, but we still have the token!
            }
        } catch (dbError) {
            console.warn('Database Sync Exception:', dbError.message);
        }

        res.send('<html><body style="font-family:sans-serif;text-align:center;padding-top:50px;"><h2>Success!</h2><p>Refresh token generated and saved. Your backend is now using the updated master token.</p><p>You can close this window now.</p></body></html>');
    } catch (error) {
        console.error('Linking error:', error.message || error);
        res.status(500).send(`Failed to link account: ${error.message}`);
    }
};

exports.checkMasterHealth = async (req, res) => {
    try {
        const token = process.env.MASTER_REFRESH_TOKEN;
        if (!token) {
            return res.status(404).json({ 
                status: 'missing', 
                message: 'No Master Refresh Token configured in .env' 
            });
        }

        // Test the token
        const oauth2Client = GoogleDriveService.getOAuth2Client();
        oauth2Client.setCredentials({ refresh_token: token });
        
        try {
            await oauth2Client.getAccessToken();
            res.json({ 
                status: 'healthy', 
                message: 'Master token is valid and active.' 
            });
        } catch (tokenErr) {
            res.status(401).json({ 
                status: 'invalid', 
                message: 'Master token is expired or revoked.',
                error: tokenErr.message
            });
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

function updateMasterRefreshToken(newToken) {
    if (!newToken) throw new Error('No refresh token provided');
    const envPath = path.resolve(__dirname, '../../.env');

    let envConfig = '';
    if (fs.existsSync(envPath)) {
        envConfig = fs.readFileSync(envPath, 'utf8');
    }

    if (envConfig.includes('MASTER_REFRESH_TOKEN=')) {
        envConfig = envConfig.replace(/MASTER_REFRESH_TOKEN=.*/g, `MASTER_REFRESH_TOKEN=${newToken}`);
    } else {
        envConfig += `\nMASTER_REFRESH_TOKEN=${newToken}`;
    }

    fs.writeFileSync(envPath, envConfig);
    console.log(`MASTER_REFRESH_TOKEN persisted to ${envPath}`);
}
