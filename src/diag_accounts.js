require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
    try {
        const { data: accounts, error: accError } = await supabase.from('accounts').select('*');
        if (accError) {
            console.error('Accounts Supabase Error:', accError);
        } else {
            console.log('Accounts data:', JSON.stringify(accounts, null, 2));
        }
    } catch (e) {
        console.error('Check failed:', e);
    }
}

check();
