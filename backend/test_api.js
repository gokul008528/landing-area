import 'dotenv/config';
import { getAllViolations } from './controllers/admin.controller.js';

async function testResponse() {
    const req = {};
    const res = {
        status: (code) => {
            console.log('Status Code:', code);
            return res;
        },
        json: (data) => {
            console.log('--- RESPONSE DATA ---');
            console.log(JSON.stringify(data.slice(0, 5), null, 2));
            console.log('\nTotal Records:', data.length);
            console.log('\nSample Record Keys:', Object.keys(data[0] || {}));
            process.exit(0);
        }
    };

    try {
        await getAllViolations(req, res);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

testResponse();