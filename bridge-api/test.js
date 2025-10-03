import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const {
  BRIDGE_API_URL = 'http://localhost:3000',
  BRIDGE_API_KEY,
} = process.env;

// Create axios instance for Bridge API
const bridge = axios.create({
  baseURL: BRIDGE_API_URL,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${BRIDGE_API_KEY}`
  }
});

// Test data
const testPost = {
  title: 'Test Post ' + Date.now(),
  content: 'This is a test post created by the Bridge API test suite.',
  status: 'draft'
};

// Helper function to log responses
const logResponse = (action, response) => {
  console.log(`\n=== ${action} ===`);
  console.log('Status:', response.status);
  console.log('Data:', JSON.stringify(response.data, null, 2));
};

// Run tests
async function runTests() {
  try {
    // Test 1: Create post
    console.log('\nTesting post creation...');
    const createResponse = await bridge.post('/posts', testPost);
    logResponse('CREATE POST', createResponse);
    const postId = createResponse.data.id;

    // Test 2: Get posts list
    console.log('\nTesting posts list...');
    const listResponse = await bridge.get('/posts');
    logResponse('LIST POSTS', listResponse);

    // Test 3: Get single post
    console.log('\nTesting single post retrieval...');
    const getResponse = await bridge.get(`/posts/${postId}`);
    logResponse('GET POST', getResponse);

    // Test 4: Update post
    console.log('\nTesting post update...');
    const updateResponse = await bridge.patch(`/posts/${postId}`, {
      title: 'Updated Test Post',
      content: 'This post was updated by the test suite.'
    });
    logResponse('UPDATE POST', updateResponse);

    // Test 5: Delete post
    console.log('\nTesting post deletion...');
    const deleteResponse = await bridge.delete(`/posts/${postId}`);
    logResponse('DELETE POST', deleteResponse);

  } catch (error) {
    console.error('\n=== ERROR ===');
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('Response Error:', {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else if (error.request) {
      // The request was made but no response was received
      console.error('Request Error:', error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Setup Error:', error.message);
    }
  }
}

// Run all tests
console.log('Starting Bridge API tests...');
runTests().then(() => {
  console.log('\nTests completed!');
}).catch(err => {
  console.error('\nTest suite failed:', err);
  process.exit(1);
});
