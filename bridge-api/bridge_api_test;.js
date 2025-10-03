import axios from 'axios';

const wp = axios.create({
  baseURL: process.env.WP_BASE_URL,
  auth: {                    // axios will send Basic <base64(user:pass)>
    username: process.env.WP_BASIC_USER,
    password: process.env.WP_BASIC_PASS
  },
  // If your WP API path needs it:
  // baseURL: `${process.env.WP_BASE_URL}/wp-json/wp/v2`
});

app.post('/posts', authBridge, async (req, res) => {
  const { title, content, status = 'publish' } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Missing title or content' });

  try {
    const { data } = await wp.post('/posts', { title, content, status });
    res.json(data);
  } catch (e) {
    const detail = e.response?.data || e.message;
    res.status(e.response?.status || 500).json({ error: 'Failed to create post', detail });
  }
});
