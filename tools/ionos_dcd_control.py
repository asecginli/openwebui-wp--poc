"""
title: IONOS DCD Control
author: OpenWebUI
version: 0.1.0
requirements: requests
description: |
  Tools for managing IONOS Cloud Data Center Designer (DCD) resources,
  including datacenters and servers, via the IONOS Cloud API.
tags: ionos, cloud, datacenter, server, dcd, api, tools, openwebui
"""

import json
import os
from typing import Any, Dict, Iterable, Optional, Tuple

import requests
from requests.auth import HTTPBasicAuth


class IonosConfig:
    """Configuration pulled from environment for accessing IONOS Cloud API."""

    def __init__(self) -> None:
        base = os.getenv(
            "IONOS_CLOUD_API_BASE_URL", "https://api.ionos.com/cloudapi/v6"
        )
        self.api_base = base.rstrip("/")
        token = os.getenv("IONOS_API_TOKEN", "").strip()
        username = os.getenv("IONOS_USERNAME", "").strip()
        password = os.getenv("IONOS_PASSWORD", "").strip()

        self.auth: Optional[HTTPBasicAuth] = None
        if token:
            self.auth_header = {"Authorization": f"Bearer {token}"}
        elif username and password:
            self.auth_header = {}
            self.auth = HTTPBasicAuth(username, password)
        else:
            raise ValueError(
                "Set IONOS_API_TOKEN or both IONOS_USERNAME and IONOS_PASSWORD."
            )

    def headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        headers.update(self.auth_header)
        return headers


class Tools:  # must be named Tools for OpenWebUI to load it
    """Helper utilities for interacting with the IONOS Cloud Data Center Designer."""

    def __init__(self, config: Optional[IonosConfig] = None) -> None:
        self._init_error: Optional[str] = None
        self.config: Optional[IonosConfig]
        self.session: Optional[requests.Session]

        try:
            self.config = config or IonosConfig()
            self.session = requests.Session()
            self.session.headers.update(self.config.headers())
            if self.config.auth is not None:
                self.session.auth = self.config.auth
        except Exception as exc:
            self.config = None
            self.session = None
            self._init_error = "Unable to initialize IONOS client: {exc}".format(exc=exc)

    def _ready(self) -> Optional[str]:
        if self._init_error:
            return self._init_error
        if self.config is None or self.session is None:
            return "IONOS client is not initialized."
        return None

    def _request(
        self,
        method: str,
        path: str,
        *,
        expected: Tuple[int, ...] = (200,),
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Tuple[bool, Any]:
        readiness = self._ready()
        if readiness:
            return False, {"error": "configuration", "detail": readiness}

        config = self.config
        session = self.session
        if config is None or session is None:
            return False, {
                "error": "configuration",
                "detail": "IONOS client is not initialized.",
            }

        url = f"{config.api_base}/{path.lstrip('/')}"
        try:
            response = session.request(
                method=method,
                url=url,
                params=params,
                json=json_body,
                timeout=45,
            )
        except requests.exceptions.Timeout:
            return False, {
                "error": "timeout",
                "detail": "Request to IONOS API timed out.",
            }
        except requests.exceptions.ConnectionError:
            return False, {
                "error": "connection_error",
                "detail": "Unable to reach IONOS API endpoint.",
            }
        except Exception as exc:
            return False, {"error": "unexpected_error", "detail": str(exc)}

        if response.status_code not in expected:
            return False, {
                "error": f"http_{response.status_code}",
                "detail": self._response_body(response),
                "headers": dict(response.headers),
            }

        return True, self._response_body(response)

    @staticmethod
    def _response_body(response: Any) -> Any:
        try:
            return response.json()
        except ValueError:
            text = (getattr(response, "text", "") or "").strip()
            return text[:600] + ("..." if len(text) > 600 else "")

    @staticmethod
    def _stringify(value: Any, limit: int = 600) -> str:
        if value is None:
            return "n/a"
        if isinstance(value, str):
            text = value.strip()
        else:
            text = json.dumps(value, ensure_ascii=True, indent=2)
        return text[:limit] + ("..." if len(text) > limit else "")

    def _format_error(self, action: str, detail: Any) -> str:
        if isinstance(detail, dict):
            error_type = detail.get("error", "unknown")
            description = detail.get("detail")
        else:
            error_type = "unknown"
            description = detail

        lines = [f"Error {action}."]
        lines.append(f"- type: {error_type}")
        if description:
            lines.append(f"- detail: {self._stringify(description)}")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # datacenter operations
    # ------------------------------------------------------------------
    def list_datacenters(self) -> str:
        ok, data = self._request("get", "datacenters")
        if not ok:
            return self._format_error("listing datacenters", data)

        items = data.get("items", []) if isinstance(data, dict) else []
        if not items:
            return "No datacenters found."

        lines = ["Datacenters:"]
        for item in items:
            props = item.get("properties", {})
            lines.append(
                f"- {item.get('id')} | name: {props.get('name')} | location: {props.get('location')}"
            )
        return "\n".join(lines)

    def create_datacenter(self, name: str, location: str, description: str = "") -> str:
        payload = {
            "properties": {
                "name": name,
                "location": location,
                "description": description,
            }
        }
        ok, data = self._request(
            "post",
            "datacenters",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("creating datacenter", data)
        return "Datacenter creation requested.\n" + self._stringify(data)

    def delete_datacenter(self, datacenter_id: str) -> str:
        ok, data = self._request(
            "delete",
            f"datacenters/{datacenter_id}",
            expected=(202, 204),
            params={"depth": 0},
        )
        if not ok:
            return self._format_error(f"deleting datacenter {datacenter_id}", data)
        return f"Deletion initiated for datacenter {datacenter_id}."

    # ------------------------------------------------------------------
    # server operations
    # ------------------------------------------------------------------
    def list_servers(self, datacenter_id: str) -> str:
        ok, data = self._request("get", f"datacenters/{datacenter_id}/servers")
        if not ok:
            return self._format_error(f"listing servers in {datacenter_id}", data)

        items = data.get("items", []) if isinstance(data, dict) else []
        if not items:
            return f"No servers found in datacenter {datacenter_id}."

        lines = [f"Servers in {datacenter_id}:"]
        for item in items:
            props = item.get("properties", {})
            lines.append(
                f"- {item.get('id')} | name: {props.get('name')} | cores: {props.get('cores')} | state: {props.get('vmState')}"
            )
        return "\n".join(lines)

    def create_basic_server(
        self,
        datacenter_id: str,
        name: str,
        cores: int = 2,
        ram_mb: int = 4096,
        availability_zone: str = "AUTO",
    ) -> str:
        payload = {
            "properties": {
                "name": name,
                "cores": cores,
                "ram": ram_mb,
                "availabilityZone": availability_zone,
            }
        }
        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("creating server", data)
        return "Server creation requested.\n" + self._stringify(data)

    def set_server_power_state(
        self,
        datacenter_id: str,
        server_id: str,
        action: str,
    ) -> str:
        action = action.lower()
        if action not in {"start", "stop", "reboot"}:
            return "Action must be one of: start, stop, reboot."

        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers/{server_id}/{action}",
            expected=(202,),
        )
        if not ok:
            return self._format_error(
                f"{action} server {server_id} in {datacenter_id}",
                data,
            )
        return f"Server {server_id} {action} request accepted."

    # ------------------------------------------------------------------
    # request tracking
    # ------------------------------------------------------------------
    def get_request_status(self, request_id: str) -> str:
        ok, data = self._request("get", f"requests/{request_id}/status")
        if not ok:
            return self._format_error(f"checking request {request_id}", data)
        return "Request status:\n" + self._stringify(data)


