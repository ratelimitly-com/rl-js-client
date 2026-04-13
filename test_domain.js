const { createClient, ResourceRequest, LatencyGuard } = require('./client.js');

function test() {
    console.log('Testing JavaScript R-Client with domain name...');
    
    // Use domain name instead of IP for HA support
    const client = createClient('ratelimitly.local', 12345);
    
    const resources = [new ResourceRequest('api_calls', 60000, 100, 1)];
    const guards = [new LatencyGuard('database', 100.0)];
    
    console.log('Testing with domain name: ratelimitly.local');
    
    // Test rate limit check
    client.checkRateLimit(resources, guards, (error, result) => {
        if (error) {
            console.error('❌ Rate limit check failed:', error.message);
            return;
        }
        
        console.log('✅ Rate limit check completed');
        console.log('   Success:', result.success);
        console.log('   Server ID:', result.serverId);
        console.log('   Guards:', result.guardResults.length);
        console.log('   Resources:', result.resourceResults.length);
        
        // Test latency reporting
        client.reportLatency('database', 85.5, (latencyError) => {
            if (latencyError) {
                console.warn('⚠️  Latency report failed:', latencyError.message);
            } else {
                console.log('✅ Latency reported');
            }
            
            // Show server stats
            const stats = client.getServerStats();
            console.log('📊 Server stats:');
            console.log('   Servers:', stats.servers);
            console.log('   Stable servers:', stats.stableServers);
            
            console.log('Test completed!');
        });
    });
}

// Add localhost entry instructions
console.log('📝 Setup instructions:');
console.log('   1. Add to /etc/hosts: echo "127.0.0.1 ratelimitly.local" | sudo tee -a /etc/hosts');
console.log('   2. Start a compatible server bound to UDP port 8080');
console.log('   3. Run this test: node test_domain.js');
console.log('');

test();
