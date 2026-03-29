const { google } = require('googleapis');
const logger = require('./logger');
const ConfigService = require('./configService');

class GoogleDriveService {
    static normalizeTokens(tokens) {
        if (!tokens) return null;
        const normalized = { ...tokens };
        if (normalized.expiry_date) {
            if (typeof normalized.expiry_date === 'string') {
                const parsed = Date.parse(normalized.expiry_date);
                if (!Number.isNaN(parsed)) normalized.expiry_date = parsed;
            } else if (normalized.expiry_date instanceof Date) {
                normalized.expiry_date = normalized.expiry_date.getTime();
            }
        }
        return normalized;
    }

    static async getOAuth2Client(tokens = null, useRedirect = false) {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            useRedirect ? process.env.GOOGLE_REDIRECT_URI : null
        );

        let activeTokens = tokens;
        if (!activeTokens) {
            const masterToken = await ConfigService.getMasterToken();
            if (masterToken) {
                activeTokens = { refresh_token: masterToken };
            }
        }

        const normalizedTokens = this.normalizeTokens(activeTokens);
        if (normalizedTokens) {
            oauth2Client.setCredentials(normalizedTokens);
        }

        // Listen for token refreshes
        oauth2Client.on('tokens', async (newTokens) => {
            if (newTokens.refresh_token) {
                logger.info('New Refresh Token received, updating persistence...');
                await ConfigService.updateMasterToken(newTokens.refresh_token);
            }
        });

        return oauth2Client;
    }

    static async getMasterDrive() {
        logger.debug('Initializing Master Drive access...');
        const masterToken = await ConfigService.getMasterToken();
        const auth = await this.getOAuth2Client(masterToken ? { refresh_token: masterToken } : null, false);
        try {
            await auth.getAccessToken();
            return google.drive({ version: 'v3', auth });
        } catch (error) {
            logger.error('Master Drive authorization failed', { error: error.message });
            throw error;
        }
    }

    static async getDrive(tokens = null) {
        // General API calls NEVER need a redirect URI
        const auth = await this.getOAuth2Client(tokens, false);
        try {
            await auth.getAccessToken();
            const credentials = { ...auth.credentials };
            return { drive: google.drive({ version: 'v3', auth }), credentials };
        } catch (error) {
            logger.error('Google Drive auth error', { error: error.message });
            throw error;
        }
    }

    static async listFiles(tokens, folderId = null) {
        const { drive, credentials } = await this.getDrive(tokens);
        const q = folderId ? `'${folderId}' in parents and trashed=false` : 'trashed=false';
        const response = await drive.files.list({
            q: q,
            fields: 'files(id, name, size, mimeType, createdTime, modifiedTime)',
        });
        return { files: response.data.files, credentials };
    }

    static async uploadFile(tokens, fileMetadata, media) {
        const { drive, credentials } = await this.getDrive(tokens);
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });
        return { fileId: response.data.id, credentials };
    }

    static async deleteFile(tokens, fileId) {
        const { drive, credentials } = await this.getDrive(tokens);
        await drive.files.delete({ fileId });
        return { credentials };
    }

    static async getStorageQuota(tokens) {
        const { drive, credentials } = await this.getDrive(tokens);
        const response = await drive.about.get({
            fields: 'storageQuota',
        });
        return { quota: response.data.storageQuota, credentials };
    }

    static async getOrCreateFolder(drive, folderName) {
        const response = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
            fields: 'files(id, name)',
        });

        if (response.data.files.length > 0) {
            return response.data.files[0].id;
        }

        const folderMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
        };

        const folder = await drive.files.create({
            resource: folderMetadata,
            fields: 'id',
        });

        return folder.data.id;
    }
}

module.exports = GoogleDriveService;

