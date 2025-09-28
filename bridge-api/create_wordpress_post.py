"""
title: WordPress Post Creator
author: OpenWebUI
version: 1.1.0
requirements: requests
"""

import os
import requests
from typing import Optional

class Tools:
    def __init__(self):
        self.api_url = os.getenv("API_BASE_URL", "https://api.agnsai.ddns.net/posts")
        self.api_key = os.getenv("BRIDGE_API_KEY", "a17e7b0221386d91e5dc7a4a40ac9801384c0cd3e67f11234f067b8b71cab613")  # <-- set this in OpenWebUI env

    def create_wordpress_post(self, title: str, content: str, status: str = "publish") -> str:
        payload = {"title": title, "content": content, "status": status}
        headers = {"Content-Type": "application/json"}

        # include the API key
        if self.api_key:
            headers["X-API-Key"] = self.api_key

        try:
            r = requests.post(self.api_url, json=payload, headers=headers, timeout=30)

            # accept both 200 and 201 (WP returns 201 on create)
            if r.status_code in (200, 201):
                data = r.json()
                return (
                    "✅ Blog post created successfully!\n\n"
                    f"Title: {data.get('title', title)}\n"
                    f"ID: {data.get('id', 'Unknown')}\n"
                    f"Status: {data.get('status', status)}\n"
                    f"URL: {data.get('link', 'N/A')}"
                )

            # bubble up bridge/WP errors
            return f"❌ Error creating post (HTTP {r.status_code}):\n{r.text}"

        except requests.exceptions.Timeout:
            return "❌ Request timed out. Please try again."
        except requests.exceptions.ConnectionError:
            return "❌ Cannot connect to the Bridge API. Check DNS/SSL/proxy."
        except Exception as e:
            return f"❌ Unexpected error: {e}"
