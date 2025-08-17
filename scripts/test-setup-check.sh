#!/bin/bash

# Integration Test Setup Verification Script
# This script helps verify that your integration test environment is properly configured

echo "🔍 Checking Integration Test Setup..."
echo ""

# Check if .env.test file exists
if [ -f ".env.test" ]; then
    echo "✅ .env.test file exists"
else
    echo "❌ .env.test file is missing"
    echo "   Create .env.test with test environment variables"
    exit 1
fi

# Check if DATABASE_URL is set in .env.test
if grep -q "DATABASE_URL" .env.test; then
    echo "✅ DATABASE_URL is configured in .env.test"
    DATABASE_URL=$(grep "DATABASE_URL" .env.test | cut -d'=' -f2- | tr -d '"')
    echo "   Using: ${DATABASE_URL:0:50}..."
else
    echo "❌ DATABASE_URL not found in .env.test"
    exit 1
fi

# Check if Node.js can load the test environment
echo ""
echo "🔧 Testing environment loading..."
if node -e "require('dotenv').config({path: '.env.test'}); console.log('NODE_ENV:', process.env.NODE_ENV)" | grep -q "test"; then
    echo "✅ Test environment loads correctly"
else
    echo "❌ Failed to load test environment"
    exit 1
fi

# Test database connection
echo ""
echo "🗄️  Testing database connection..."
node -e "
require('dotenv').config({path: '.env.test'});
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
    try {
        await prisma.\$connect();
        console.log('✅ Database connection successful');
        await prisma.\$disconnect();
    } catch (error) {
        console.log('❌ Database connection failed:', error.message);
        process.exit(1);
    }
})();
" || {
    echo ""
    echo "💡 Database connection failed. This could be because:"
    echo "   1. The database URL is incorrect"
    echo "   2. The database server is not running"
    echo "   3. Network connectivity issues"
    echo "   4. Database credentials are invalid"
    echo ""
    echo "🔧 Possible solutions:"
    echo "   1. Update DATABASE_URL in .env.test to point to your test database"
    echo "   2. Use a local PostgreSQL database for testing"
    echo "   3. Use SQLite for testing (requires schema changes)"
    echo "   4. Use Docker to run a test database"
    echo ""
    exit 1
}

# Test app creation
echo ""
echo "🚀 Testing app creation..."
node -e "
require('dotenv').config({path: '.env.test'});
const { build } = require('./src/app.js');

(async () => {
    try {
        const app = await build({ logger: false });
        console.log('✅ Test app creation successful');
        await app.close();
    } catch (error) {
        console.log('❌ Test app creation failed:', error.message);
        process.exit(1);
    }
})();
" || {
    echo "❌ Failed to create test app"
    exit 1
}

echo ""
echo "🎉 Integration test setup verification complete!"
echo ""
echo "📋 Next steps to enable integration tests:"
echo "   1. Run: npm test -- tests/integration"
echo "   2. Check test results"
echo "   3. Uncomment .skip() in test files if tests pass"
echo ""
