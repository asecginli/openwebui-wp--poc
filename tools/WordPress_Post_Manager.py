"""
title: WordPress Post Manager
author: OpenWebUI
version: 1.3.1
requirements: requests
description: |
  Create a new WordPress blog post via the Bridge API. Retrieve details of a WordPress blog post by ID. 
  Update an existing WordPress blog post (partial update). 
  Search for WordPress blog posts using filters such as keywords, status, author, and sort order.
tags: wordpress, bridge, api, tools, openwebui
"""

import os
import requests
from typing import Optional, Dict, Any, List


class Tools:
    API_BASE_URL = os.getenv("API_BASE_URL")  # Fetch from .env

    def __init__(self):
        """
        Initialize the WordPress Post Manager.
        Uses API_BASE_URL and BRIDGE_API_KEY from environment variables.
        """
        """
        Initialize the WordPress Post Manager.
        Uses API_BASE_URL and BRIDGE_API_KEY from environment variables.
        """
        if not self.API_BASE_URL:
            raise ValueError(
                f"❌ API_BASE_URL is not set in the environment variables. API_BASE_URL: {os.getenv('API_BASE_URL')}"
            )
        self.api_url = self.API_BASE_URL + "/posts"

        self.api_key = os.getenv("BRIDGE_API_KEY")
        if not self.api_key:
            raise ValueError(
                "❌ BRIDGE_API_KEY is not set in the environment variables."
            )

        self.timeout = 30  # Restrict timeout to prevent hanging requests

    # ---------- internal helpers ----------
    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["X-API-Key"] = self.api_key
        return h

    def _handle_response(self, r, ok_statuses=(200,)) -> Any:
        """
        Normalize Bridge API responses.

        Args:
          r: HTTP response object (e.g., from requests).
          ok_statuses (tuple[int]): Status codes to treat as success.

        Returns:
          dict|list: Parsed JSON on success, or an error dict:
                     { "error": "HTTP <code>", "detail": "<truncated body>" }
        """
        try:
            status = getattr(r, "status_code", None)
        except Exception:
            return {"error": "ResponseError", "detail": "Invalid response object"}

        if status in ok_statuses:
            try:
                return r.json()
            except Exception:
                try:
                    return {"raw": r.text}
                except Exception:
                    return {"raw": "<no text>"}

        # Non-OK path
        detail = ""
        try:
            detail = r.text[:2000]
        except Exception:
            detail = "<no text>"
        return {"error": f"HTTP {status}", "detail": detail}

    def _safe_url(self, *parts: str) -> str:
        base = self.api_url.rstrip("/")
        tail = "/".join(p.strip("/") for p in parts if p is not None)
        return f"{base}/{tail}" if tail else base

    # ---------- main functions (LLM-annotated) ----------

    def create_wordpress_post(
        self, title: str, content: str, status: str = "publish"
    ) -> str:
        """
        Description (LLM):
          Create a new WordPress post via the Bridge API.

        Args:
          title (str): Post title.
          content (str): Post body (HTML or text).
          status (str): 'publish' | 'draft' | 'pending'. Default: 'publish'.

        Returns:
          str: Human-friendly result with ID/URL or a clear error.

        Example:
          tools.create_wordpress_post("Hello", "<p>Body</p>", "publish")
        """
        payload = {"title": title, "content": content, "status": status}
        try:
            r = requests.post(
                self._safe_url(),
                json=payload,
                headers=self._headers(),
                timeout=self.timeout,
            )
            data = self._handle_response(r, ok_statuses=(200, 201))
            if "error" in data:
                return f"❌ Error creating post ({data['error']}):\n{data.get('detail','')}"
            return (
                "✅ Blog post created successfully!\n\n"
                f"Title: {data.get('title', title)}\n"
                f"ID: {data.get('id', 'Unknown')}\n"
                f"Status: {data.get('status', status)}\n"
                f"URL: {data.get('link', 'N/A')}"
            )
        except requests.exceptions.Timeout:
            return "❌ Request timed out. Please try again."
        except requests.exceptions.ConnectionError:
            return "❌ Cannot connect to the Bridge API. Check DNS/SSL/proxy."
        except Exception as e:
            return f"❌ Unexpected error: {e}"

    def get_wordpress_post(self, post_id: int) -> str:
        """
        Description (LLM):
          Fetch a single WordPress post by ID and return a compact summary.

        Args:
          post_id (int): WordPress post ID.

        Returns:
          str: Title, status, URL, and an excerpt preview (if available).

        Example:
          tools.get_wordpress_post(123)
        """
        try:
            r = requests.get(
                self._safe_url(str(post_id)),
                headers=self._headers(),
                timeout=self.timeout,
            )
            data = self._handle_response(r, ok_statuses=(200,))
            if "error" in data:
                return f"❌ Error fetching post {post_id} ({data['error']}):\n{data.get('detail','')}"

            # Ensure excerpt is a string before slicing
            excerpt = data.get("excerpt", {}).get("rendered", "")
            if not isinstance(excerpt, str):
                excerpt = ""

            preview = excerpt[:500] + ("…" if len(excerpt) > 500 else "")
            return (
                "📝 Post details\n\n"
                f"Title: {data.get('title', {}).get('rendered', 'N/A')}\n"
                f"ID: {data.get('id', post_id)}\n"
                f"Status: {data.get('status', 'N/A')}\n"
                f"URL: {data.get('link', 'N/A')}\n\n"
                f"Excerpt:\n{preview}"
            )
        except requests.exceptions.Timeout:
            return "❌ Request timed out while fetching the post."
        except requests.exceptions.ConnectionError:
            return "❌ Cannot connect to the Bridge API. Check DNS/SSL/proxy."
        except Exception as e:
            return f"❌ Unexpected error: {e}"

    def update_wordpress_post(
        self,
        post_id: int,
        title: Optional[str] = None,
        content: Optional[str] = None,
        status: Optional[str] = None,
    ) -> str:
        """
        Description (LLM):
          Partially update an existing WordPress post (PATCH).

        Args:
          post_id (int): WordPress post ID.
          title (str, optional): New title.
          content (str, optional): New content (HTML/text).
          status (str, optional): New status ('publish' | 'draft' | 'pending').

        Returns:
          str: Human-friendly result with updated values or an error.

        Example:
          tools.update_wordpress_post(123, title="Updated title")
        """
        payload: Dict[str, Any] = {}
        if title is not None:
            payload["title"] = title
        if content is not None:
            payload["content"] = content
        if status is not None:
            payload["status"] = status

        if not payload:
            return (
                "ℹ️ Nothing to update. Provide at least one of: title, content, status."
            )

        try:
            # Use PATCH instead of POST for partial updates
            r = requests.patch(
                self._safe_url(str(post_id)),
                json=payload,
                headers=self._headers(),
                timeout=self.timeout,
            )
            data = self._handle_response(r, ok_statuses=(200,))
            if "error" in data:
                return f"❌ Error updating post {post_id} ({data['error']}):\n{data.get('detail','')}"
            return (
                "✅ Post updated successfully!\n\n"
                f"Title: {data.get('title', {}).get('rendered', title or 'N/A')}\n"
                f"ID: {data.get('id', post_id)}\n"
                f"Status: {data.get('status', status or 'N/A')}\n"
                f"URL: {data.get('link', 'N/A')}"
            )
        except requests.exceptions.Timeout:
            return "❌ Request timed out while updating the post."
        except requests.exceptions.ConnectionError:
            return "❌ Cannot connect to the Bridge API. Check DNS/SSL/proxy."
        except Exception as e:
            return f"❌ Unexpected error: {e}"

    def search_wordpress_posts(
        self,
        query: Optional[str] = None,
        per_page: int = 10,
        page: int = 1,
        status: Optional[str] = None,
        author: Optional[int] = None,
        orderby: Optional[str] = None,
        order: Optional[str] = None,
    ) -> str:
        """
        Description (LLM):
          Search or list WordPress posts with pagination and filters.

        Args:
          query (str, optional): Full-text search keyword.
          per_page (int): Items per page (default 10).
          page (int): Page number (default 1).
          status (str, optional): Filter by status.
          author (int, optional): Filter by author ID.
          orderby (str, optional): e.g., 'date' | 'title'.
          order (str, optional): 'asc' | 'desc'.

        Returns:
          str: Bulleted result lines in the form:
               - [ID] Title — status — URL

        Example:
          tools.search_wordpress_posts(query="openwebui", per_page=5, orderby="date", order="desc")
        """
        params: Dict[str, Any] = {"per_page": per_page, "page": page}
        if query:
            params["search"] = query
        if status:
            params["status"] = status
        if author is not None:
            params["author"] = author
        if orderby:
            params["orderby"] = orderby
        if order:
            params["order"] = order

        try:
            r = requests.get(
                self._safe_url(),
                headers=self._headers(),
                params=params,
                timeout=self.timeout,
            )
            data = self._handle_response(r, ok_statuses=(200,))
            if "error" in data:
                return f"❌ Error searching posts ({data['error']}):\n{data.get('detail','')}"
            if not isinstance(data, list) or not data:
                return "🔎 No posts found."

            lines: List[str] = [
                f"🔎 Search results (page {page}, {len(data)} item(s)):"
            ]
            for p in data:
                lines.append(
                    f"- [{p.get('id','?')}] {p.get('title','(no title)')} "
                    f"— {p.get('status','?')} — {p.get('link','N/A')}"
                )
            return "\n".join(lines)
        except requests.exceptions.Timeout:
            return "❌ Request timed out while searching posts."
        except requests.exceptions.ConnectionError:
            return "❌ Cannot connect to the Bridge API. Check DNS/SSL/proxy."
        except Exception as e:
            return f"❌ Unexpected error: {e}"

    def delete_wordpress_post(self, post_id: int) -> str:
        """
        Description (LLM):
          Delete a WordPress post by ID.

        Args:
          post_id (int): WordPress post ID.

        Returns:
          str: Success message or error details.

        Example:
          tools.delete_wordpress_post(123)
        """
        try:
            r = requests.delete(
                self._safe_url(str(post_id)),
                headers=self._headers(),
                timeout=self.timeout,
            )
            data = self._handle_response(r, ok_statuses=(200,))
            if "error" in data:
                return f"❌ Error deleting post {post_id} ({data['error']}):\n{data.get('detail','')}"
            return f"✅ Post {post_id} deleted successfully."
        except requests.exceptions.Timeout:
            return "❌ Request timed out while deleting the post."
        except requests.exceptions.ConnectionError:
            return "❌ Cannot connect to the Bridge API. Check DNS/SSL/proxy."
        except Exception as e:
            return f"❌ Unexpected error: {e}"
