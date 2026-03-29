const supabase = require('../services/supabaseClient');
const GoogleDriveService = require('../services/googleDriveService');
const fs = require('fs');

exports.listFiles = async (req, res) => {
    const { userId } = req.query;

    try {
        let drive;
        let queryAddition = "'root' in parents";
        let masterTokenError = null;

        // Try to get individual accounts
        const { data: accounts, error: accountsError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId);

        if (accountsError) {
            console.error('[ListFiles] Failed to fetch accounts:', accountsError.message);
            return res.status(500).json({ error: 'Unable to query linked accounts' });
        }

        if (process.env.MASTER_REFRESH_TOKEN) {
            try {
                console.log(`[ListFiles] Using Master Drive for user: ${userId}`);
                drive = await GoogleDriveService.getMasterDrive();
                const folderId = await GoogleDriveService.getOrCreateFolder(drive, `cloudhyve_user_${userId}`);
                queryAddition = `'${folderId}' in parents`;
                
                const response = await drive.files.list({
                    q: `${queryAddition} and trashed=false`,
                    fields: 'files(id, name, size, mimeType, createdTime, modifiedTime)',
                });
                const files = response.data.files.map(f => ({ ...f, account_email: 'CloudHyve Shared Storage' }));
                return res.json(files);
            } catch (masterErr) {
                if (isInvalidGrant(masterErr)) {
                    masterTokenError = masterErr;
                    console.warn('[ListFiles] Master refresh token invalid. Falling back to individual accounts.');
                } else {
                    throw masterErr;
                }
            }
        }

        if (accounts && accounts.length > 0) {
            // Fallback: Individual account logic
            let allFiles = [];
            for (const account of accounts) {
                try {
                    const tokens = {
                        access_token: account.access_token,
                        refresh_token: account.refresh_token,
                        expiry_date: account.expiry_date
                    };
                    const { drive: accDrive } = await GoogleDriveService.getDrive(tokens);
                    const folderId = await GoogleDriveService.getOrCreateFolder(accDrive, 'CloudHyve');
                    const { files: driveFiles, credentials } = await GoogleDriveService.listFiles(tokens, folderId);
                    await persistAccountCredentials(account.id, credentials);
                    const enriched = driveFiles.map(f => ({ ...f, account_email: account.email }));
                    allFiles = [...allFiles, ...enriched];
                } catch (accErr) {
                    console.log(`[ListFiles] Skipped failing individual account ${account.email}`);
                }
            }
            return res.json(allFiles);
        } else {
            if (masterTokenError) {
                return res.status(401).json({ 
                    error: 'Master Refresh Token Expired', 
                    message: 'Your Google Drive Master account needs to be re-authenticated. Please visit http://localhost:3000/auth/link to refresh.',
                    code: 'INVALID_GRANT'
                });
            }
            return res.json([]);
        }
    } catch (error) {
        console.error('List files error:', error.message || error);
        if (isInvalidGrant(error)) {
            return res.status(401).json({ 
                error: 'Master Refresh Token Expired', 
                message: 'Your Google Drive Master account needs to be re-authenticated. Please visit http://localhost:3000/auth/link to refresh.',
                code: 'INVALID_GRANT'
            });
        }
        res.status(500).json({ error: 'Failed to list files', details: error.message });
    }
};

exports.uploadFile = async (req, res) => {
    const { userId } = req.body;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ error: 'No file provided' });
    }

    try {
        console.log(`Upload attempt received for User ID: ${userId}, File: ${file.originalname}`);
        
        // 1. Determine drive and parent folder
        let drive;
        let parentFolderId = null;
        let accountId = null;
        let masterTokenError = null;

        const { data: accounts, error: accountsError } = await supabase
            .from('accounts')
            .select('*')
            .eq('user_id', userId);

        if (accountsError) {
            console.error('[Upload] Failed to fetch accounts:', accountsError.message);
            throw new Error('Unable to fetch linked accounts');
        }

        if (process.env.MASTER_REFRESH_TOKEN) {
            try {
                drive = await GoogleDriveService.getMasterDrive();
                parentFolderId = await GoogleDriveService.getOrCreateFolder(drive, `cloudhyve_user_${userId}`);
                console.log(`[Upload] Using Master Account Folder: ${parentFolderId}`);
            } catch (masterErr) {
                if (isInvalidGrant(masterErr)) {
                    masterTokenError = masterErr;
                    console.warn('[Upload] Master refresh token invalid, attempting individual account fallback.');
                } else {
                    throw masterErr;
                }
            }
        }

        if (!drive && accounts && accounts.length > 0) {
            const targetAccount = accounts[0];
            accountId = targetAccount.id;
            const tokens = {
                access_token: targetAccount.access_token,
                refresh_token: targetAccount.refresh_token,
                expiry_date: targetAccount.expiry_date
            };
            const driveContext = await GoogleDriveService.getDrive(tokens);
            drive = driveContext.drive;
            parentFolderId = await GoogleDriveService.getOrCreateFolder(drive, 'CloudHyve');
            await persistAccountCredentials(targetAccount.id, driveContext.credentials);
        } else if (!drive) {
            if (masterTokenError) {
                return res.status(401).json({ 
                    error: 'Master Refresh Token Expired', 
                    message: 'Upload failed: Google Drive master account needs re-authentication.',
                    code: 'INVALID_GRANT'
                });
            }
            throw new Error('No linked Google Drive account found for this user.');
        }

        const driveFileId = await drive.files.create({
            resource: { 
                name: file.originalname,
                parents: parentFolderId ? [parentFolderId] : []
            },
            media: { 
                body: fs.createReadStream(file.path),
                mimeType: file.mimetype 
            },
            fields: 'id',
        }).then(r => r.data.id);

        // 2. Store metadata in Supabase
        const { data: fileData, error: fileError } = await supabase
            .from('files')
            .insert({
                user_id: userId,
                name: file.originalname,
                size: file.size,
                mime_type: file.mimetype
            }).select().single();

        if (fileError) throw fileError;

        await supabase.from('file_parts').insert({
            file_id: fileData.id,
            account_id: accountId, // Can be null for master
            drive_file_id: driveFileId,
            size: file.size
        });

        // 3. Update storage usage (if individual account)
        if (accountId) {
            // Atomic-ish update using rpc or direct increment if supported
            // Using a simple increment for now, but better to use postgres function 'increment_storage'
            const targetAccount = accounts[0];
            const newUsedSpace = (targetAccount.used_space || 0) + file.size;
            await supabase.from('accounts')
                .update({ used_space: newUsedSpace })
                .eq('id', targetAccount.id);
        }

        // 4. Clean up temporary file
        fs.unlink(file.path, (err) => {
            if (err) console.error(`[Cleanup] Failed to delete ${file.path}:`, err);
        });

        res.json({ message: 'Upload successful', file: fileData });
    } catch (error) {
        console.error('Upload error:', error.message || error);
        
        // Clean up temporary file on failure
        if (file && file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }

        if (isInvalidGrant(error)) {
            return res.status(401).json({ 
                error: 'Master Refresh Token Expired', 
                message: 'Upload failed: Google Drive account needs re-authentication.',
                code: 'INVALID_GRANT'
            });
        }
        res.status(500).json({ error: 'Upload failed', details: error.message });
    }
};

exports.getDashboardStats = async (req, res) => {
    const { userId } = req.query;
    console.log(`Fetching Dashboard Stats for User ID: ${userId}`);

    try {
        const { data: accounts } = await supabase
            .from('accounts')
            .select('email, total_space, used_space')
            .eq('user_id', userId);

        const { data: allFiles } = await supabase
            .from('files')
            .select('size, mime_type')
            .eq('user_id', userId);
        
        const categories = {
            category_photos: 0,
            category_videos: 0,
            category_docs: 0,
            category_others: 0
        };

        if (allFiles) {
            allFiles.forEach(f => {
                const mime = (f.mime_type || '').toLowerCase();
                const size = Number(f.size || 0);
                if (mime.startsWith('image/')) categories.category_photos += size;
                else if (mime.startsWith('video/')) categories.category_videos += size;
                else if (
                    mime.startsWith('application/pdf') || 
                    mime.startsWith('text/') || 
                    mime.includes('word') || 
                    mime.includes('document') ||
                    mime.includes('spreadsheet') ||
                    mime.includes('presentation') ||
                    mime.includes('sheet')
                ) categories.category_docs += size;
                else categories.category_others += size;
            });
        }

        let total = 15 * 1024 * 1024 * 1024; // 15GB default
        let used = (allFiles || []).reduce((acc, curr) => acc + Number(curr.size || 0), 0);
        let userAccounts = accounts || [];

        if (accounts && accounts.length > 0) {
            total = accounts.reduce((acc, curr) => acc + Number(curr.total_space || 0), 0);
        } else if (process.env.MASTER_REFRESH_TOKEN) {
            userAccounts = [{ email: 'CloudHyve Shared Storage', total_space: total, used_space: used }];
        }

        res.json({
            total_storage: total,
            used_storage: used,
            accounts: userAccounts,
            ...categories
        });

    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ 
            total_storage: 15 * 1024 * 1024 * 1024, 
            used_storage: 0, 
            accounts: [],
            category_photos: 0,
            category_videos: 0,
            category_docs: 0,
            category_others: 0,
            error: 'Failed to fetch live stats'
        });
    }
};

exports.deleteFile = async (req, res) => {
    const { userId, fileId } = req.query;

    if (!userId || !fileId) {
        return res.status(400).json({ error: 'User ID and File ID required' });
    }

    try {
        console.log(`[Delete] Attempt for User: ${userId}, File ID: ${fileId}`);

        // 1. Get file part details
        const { data: part, error: partError } = await supabase
            .from('file_parts')
            .select('*, accounts(*)')
            .eq('file_id', fileId)
            .single();

        if (partError || !part) {
            console.warn('[Delete] File mapping not found in database. Deleting DB record only.');
            await supabase.from('files').delete().eq('id', fileId);
            return res.json({ message: 'Database record removed (Drive file mapping missing)' });
        }

        // 2. Delete from Google Drive
        let drive;
        let tokens = null;
        if (process.env.MASTER_REFRESH_TOKEN && !part.account_id) {
            drive = await GoogleDriveService.getMasterDrive();
        } else if (part.accounts) {
            tokens = {
                access_token: part.accounts.access_token,
                refresh_token: part.accounts.refresh_token,
                expiry_date: part.accounts.expiry_date
            };
            const driveCtx = await GoogleDriveService.getDrive(tokens);
            drive = driveCtx.drive;
            await persistAccountCredentials(part.account_id, driveCtx.credentials);
        } else {
            throw new Error('Associated account not found for deletion');
        }

        try {
            await drive.files.delete({ fileId: part.drive_file_id });
            console.log(`[Delete] Success on Google Drive for ID: ${part.drive_file_id}`);
        } catch (driveErr) {
            console.error('[Delete] Failed to remove from Drive:', driveErr.message);
            // Continue with DB deletion even if drive fails? Depends on strategy.
            // For now, let's assume we want to keep them in sync if possible.
        }

        // 3. Update storage usage (if individual account)
        if (part.account_id) {
            const newUsedSpace = Math.max(0, (part.accounts.used_space || 0) - part.size);
            await supabase.from('accounts')
                .update({ used_space: newUsedSpace })
                .eq('id', part.account_id);
        }

        // 4. Delete from Supabase (cascade will handle file_parts)
        const { error: dbDelError } = await supabase.from('files').delete().eq('id', fileId);
        if (dbDelError) throw dbDelError;

        res.json({ message: 'File deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Delete failed', details: error.message });
    }
};

exports.getFile = async (req, res) => {
    const { fileId } = req.params;

    try {
        // 1. Get file details and part mapping
        const { data: file, error: fileErr } = await supabase
            .from('files')
            .select('*')
            .eq('id', fileId)
            .single();

        if (fileErr || !file) {
            return res.status(404).json({ error: 'File not found' });
        }

        const { data: part, error: partErr } = await supabase
            .from('file_parts')
            .select('*, accounts(*)')
            .eq('file_id', fileId)
            .single();

        if (partErr || !part) {
            return res.status(404).json({ error: 'File mapping not found' });
        }

        // 2. Get Drive Instance
        let drive;
        if (process.env.MASTER_REFRESH_TOKEN && !part.account_id) {
            drive = await GoogleDriveService.getMasterDrive();
        } else if (part.accounts) {
            const tokens = {
                access_token: part.accounts.access_token,
                refresh_token: part.accounts.refresh_token,
                expiry_date: part.accounts.expiry_date
            };
            const driveCtx = await GoogleDriveService.getDrive(tokens);
            drive = driveCtx.drive;
            await persistAccountCredentials(part.account_id, driveCtx.credentials);
        } else {
            return res.status(400).json({ error: 'Associated storage account not found' });
        }

        // 3. Stream file from Drive
        console.log(`[View] Streaming file ${file.name} (ID: ${part.drive_file_id})`);
        
        const response = await drive.files.get(
            { fileId: part.drive_file_id, alt: 'media' },
            { responseType: 'stream' }
        );

        res.set({
            'Content-Type': file.mime_type || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${file.name}"`,
            'Content-Length': file.size
        });

        response.data
            .on('error', err => {
                console.error('[View] Stream error:', err);
                res.status(500).end();
            })
            .pipe(res);

    } catch (error) {
        console.error('View file error:', error.message || error);
        if (isInvalidGrant(error)) {
            return res.status(401).json({ error: 'Auth failed with Google' });
        }
        res.status(500).json({ error: 'Failed to retrieve file' });
    }
};

async function persistAccountCredentials(accountId, credentials) {
    if (!accountId || !credentials) return;

    const update = {};
    if (credentials.access_token) {
        update.access_token = credentials.access_token;
    }
    if (credentials.refresh_token) {
        update.refresh_token = credentials.refresh_token;
    }
    if (credentials.expiry_date) {
        const expiryMs = typeof credentials.expiry_date === 'number'
            ? credentials.expiry_date
            : Date.parse(credentials.expiry_date);
        if (!Number.isNaN(expiryMs)) {
            update.expiry_date = new Date(expiryMs).toISOString();
        }
    }

    if (Object.keys(update).length === 0) return;

    const { error } = await supabase.from('accounts')
        .update(update)
        .eq('id', accountId);

    if (error) {
        console.warn(`[TokenSync] Failed to persist refreshed tokens for account ${accountId}:`, error.message);
    }
}

function isInvalidGrant(error) {
    if (!error) return false;
    const msg = (error.message || '').toLowerCase();
    const code = (error.code || '').toString();
    const status = error.status || (error.response && error.response.status);
    return msg.includes('invalid_grant') || msg.includes('unauthorized') || status === 401 || code === '401';
}
