const { createClient, ResourceRequest } = require('./client.js');

console.log('Simple test...');

const client = createClient('ratelimitly.local', 12345);
const resources = [new ResourceRequest('test', 1000, 10, 1)];

client.checkRateLimit(resources, [], (error, result) => {
    if (error) {
        console.log('Error:', error.message);
    } else {
        console.log('Success:', result.success);
    }
});