require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

console.log('MASTER_REFRESH_TOKEN:', process.env.MASTER_REFRESH_TOKEN ? 'Present' : 'Missing');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    try {
        const { count, error } = await supabase.from('files').select('*', { count: 'exact', head: true });
        if (error) {
            console.error('Supabase Error (files):', error);
        } else {
            console.log('Files count:', count);
        }

        const { data: accounts, error: accError } = await supabase.from('accounts').select('id');
        if (accError) {
            console.error('Accounts Supabase Error:', accError);
        } else {
            console.log('Accounts found:', accounts ? accounts.length : 0);
        }
    } catch (e) {
        console.error('Check failed:', e);
    }
}

check();
