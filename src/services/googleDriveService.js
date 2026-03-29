const { google } = require('googleapis');
const dotenv = require('dotenv');

dotenv.config();

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

    static getOAuth2Client(tokens = null) {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );

        const normalizedTokens = this.normalizeTokens(tokens);
        if (normalizedTokens) {
            oauth2Client.setCredentials(normalizedTokens);
        } else if (process.env.MASTER_REFRESH_TOKEN) {
            oauth2Client.setCredentials({
                refresh_token: process.env.MASTER_REFRESH_TOKEN
            });
        }

        return oauth2Client;
    }

    static async getMasterDrive() {
        console.log('[MasterDrive] Initializing Master Drive access...');
        if (!process.env.MASTER_REFRESH_TOKEN) {
            console.error('[MasterDrive] CRITICAL: MASTER_REFRESH_TOKEN is missing in Environment Variables!');
            throw new Error('MASTER_REFRESH_TOKEN missing. Generate one via /auth/link.');
        }

        console.log(`[MasterDrive] Client ID: ${process.env.GOOGLE_CLIENT_ID?.substring(0, 15)}...`);
        console.log(`[MasterDrive] Token Start: ${process.env.MASTER_REFRESH_TOKEN?.substring(0, 10)}...`);

        const { drive } = await this.getDrive();
        console.log('[MasterDrive] Master Drive successfully authorized!');
        return drive;
    }

    static async getDrive(tokens = null) {
        const auth = this.getOAuth2Client(tokens);
        try {
            await auth.getAccessToken();
            const credentials = { ...auth.credentials };
            return { drive: google.drive({ version: 'v3', auth }), credentials };
        } catch (error) {
            console.error('Google Drive auth error:', error.message || error);
            if (error.message && error.message.includes('invalid_grant')) {
                console.error('Refresh token invalid or revoked for provided credentials.');
            }
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
