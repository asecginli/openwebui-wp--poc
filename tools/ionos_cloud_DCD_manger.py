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
        token = os.getenv("IONOS_API_TOKEN","").strip()
        username = os.getenv("IONOS_USERNAME", "").strip()
        password = os.getenv("IONOS_PASSWORD", "").strip()

        print(
            "DEBUG: IonosConfig initialized with api_base:", self.api_base
        )  # Debug line
        print("DEBUG: IonosConfig token provided:", bool(token))  # Debug line
        print("DEBUG: IonosConfig username provided:", bool(username))  # Debug line
        print("DEBUG: IonosConfig password provided:", bool(password))  # Debug line

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

        print("DEBUG: IonosConfig auth set:", self.auth is not None)  # Debug line
        # Show only the first 12 characters of token for debugging (masked)
        if "Authorization" in self.auth_header:
            masked = self.auth_header["Authorization"][:20] + "..."
            print(f"DEBUG: IonosConfig auth_header: Authorization: {masked}")
        else:
            print(f"DEBUG: IonosConfig auth_header: {self.auth_header}")

    def headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        headers.update(self.auth_header)
        return headers


class Tools:  # <-- ✅ must be named Tools for OpenWebUI to load it
    """Helper utilities for interacting with the IONOS Cloud Data Center Designer."""

    def __init__(self, config: Optional[IonosConfig] = None) -> None:
        self.config = config or IonosConfig()
        self.session = requests.Session()
        self.session.headers.update(self.config.headers())
        if self.config.auth is not None:
            self.session.auth = self.config.auth

    # ------------------------------------------------------------------
    # low level helpers
    # ------------------------------------------------------------------
    def _request(
        self,
        method: str,
        path: str,
        *,
        expected: Tuple[int, ...] = (200,),
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Tuple[bool, Any]:
        url = f"{self.config.api_base}/{path.lstrip('/')}"
        try:
            response = self.session.request(
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
    def list_datacenters(self, detailed: bool = False) -> str:
        ok, data = self._request("get", "datacenters", params={"depth": 5})
        if not ok:
            return self._format_error("listing datacenters", data)

        items = data.get("items", [])
        if not items:
            return "⚠️  No datacenters found."

        lines = ["🏢 **IONOS Cloud Datacenters:**"]
        for dc in items:
            dc_id = dc.get("id")
            props = dc.get("properties", {}) or {}
            name = props.get("name") or "<no name>"
            location = props.get("location") or "<unknown>"
            desc = props.get("description") or ""
            lines.append(f"\n🗂️  Datacenter: **{name}** ({location})")
            lines.append(f"   • ID: `{dc_id}`")
            if desc:
                lines.append(f"   • Description: {desc}")
            if detailed:
                lines.extend(self._fetch_full_inventory(dc_id))
        return "\n".join(lines)

    def _fetch_full_inventory(self, datacenter_id: str) -> list[str]:
        """Return human-friendly overview of all key sub-components."""
        sections = []

        def safe(val, fallback="<unknown>"):
            return val if val not in (None, "", "None") else fallback

        # --- Servers ---
        ok, srv = self._request(
            "get", f"datacenters/{datacenter_id}/servers", params={"depth": 5}
        )
        if ok and srv.get("items"):
            sections.append("   🔹 Servers:")
            for s in srv["items"]:
                p = s.get("properties", {}) or {}
                power = safe(p.get("vmState"), "n/a")
                state_emoji = {"RUNNING": "🟢", "STOPPED": "🔴", "BUSY": "🟡"}.get(
                    power, "⚪"
                )
                sections.append(
                    f"      - {state_emoji} {safe(p.get('name'), '<no name>')} "
                    f"(Cores {safe(p.get('cores'),'?')}, RAM {safe(p.get('ram'),'?')} MB, State {power})"
                )
        else:
            sections.append("   🔹 No servers found.")

        # --- Volumes ---
        ok, vol = self._request(
            "get", f"datacenters/{datacenter_id}/volumes", params={"depth": 5}
        )
        if ok and vol.get("items"):
            sections.append("   💽 Volumes:")
            for v in vol["items"]:
                p = v.get("properties", {}) or {}
                sections.append(
                    f"      - {safe(p.get('name'), '<no name>')} "
                    f"({safe(p.get('size'), '?')} GB, Type: {safe(p.get('type'), '?')})"
                )
        else:
            sections.append("   💽 No volumes found.")

        # --- LANs ---
        ok, lan = self._request(
            "get", f"datacenters/{datacenter_id}/lans", params={"depth": 5}
        )
        if ok and lan.get("items"):
            sections.append("   🌐 LANs:")
            for l in lan["items"]:
                p = l.get("properties", {}) or {}
                lan_type = "Public 🌍" if p.get("public") else "Private 🔒"
                attached = len(l.get("entities", {}).get("nics", {}).get("items", []))
                sections.append(
                    f"      - LAN {l.get('id')} ({lan_type}, {attached} attached NICs)"
                )
        else:
            sections.append("   🌐 No LANs found.")

        # --- IP Blocks ---
        ok, ipb = self._request("get", "ipblocks", params={"depth": 1})
        if ok and ipb.get("items"):
            sections.append("   🌍 IP Blocks:")
            for i in ipb["items"]:
                p = i.get("properties", {}) or {}
                sections.append(
                    f"      - {safe(p.get('name'), '<no name>')} [{', '.join(p.get('ips', []))}]"
                )
        else:
            sections.append("   🌍 No IP blocks found.")

        # --- Load Balancers ---
        ok, lbs = self._request(
            "get", f"datacenters/{datacenter_id}/loadbalancers", params={"depth": 5}
        )
        if ok and lbs.get("items"):
            sections.append("   ⚖️  Load Balancers:")
            for lb in lbs["items"]:
                p = lb.get("properties", {}) or {}
                sections.append(
                    f"      - {safe(p.get('name'), '<no name>')} (Algo: {safe(p.get('lbAlgorithm'),'?')})"
                )
        else:
            sections.append("   ⚖️  No load balancers found.")

        return sections

    # ------------------------------------------------------------------
    # create datacenter
    # ------------------------------------------------------------------
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

    # ------------------------------------------------------------------
    # delete datacenter
    # ------------------------------------------------------------------
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


    # ------------------------------------------------------------------
    # INFRASTRUCTURE CREATION UTILITIES
    # ------------------------------------------------------------------
    def create_lan(self, datacenter_id: str, name: str, public: bool = False) -> str:
        """Create a LAN (network) inside the given datacenter."""
        payload = {"properties": {"name": name, "public": public}}
        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/lans",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("creating LAN", data)
        
        return f"🌐 LAN creation requested: **{name}** (public={public})\n{self._stringify(data)}"

    # ------------------------------------------------------------------
    # CREATE A STORAGE VOLUME
    # ------------------------------------------------------------------
    def create_volume(
        self,
        datacenter_id: str,
        name: str,
        size_gb: int,
        volume_type: str = "HDD",
        licence_type: str = "LINUX",
    ) -> str:
        """Create a storage volume."""
        payload = {
            "properties": {
                "name": name,
                "size": size_gb,
                "type": volume_type,
                "licenceType": licence_type,
            }
        }
        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/volumes",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("creating volume", data)
        return f"💽 Volume creation requested: **{name}** ({size_gb} GB, {volume_type})"


    # ------------------------------------------------------------------
    # CREATE A PUBLIC IP BLOCK
    # ------------------------------------------------------------------
    def create_ipblock(self, name: str, location: str, size: int = 1) -> str:
        """Reserve a public IP block."""
        payload = {"properties": {"name": name, "location": location, "size": size}}
        ok, data = self._request("post", "ipblocks", expected=(202,), json_body=payload)
        if not ok:
            return self._format_error("creating IP block", data)
        return f"🌍 IP block reservation requested: {name} ({size} IPs at {location})"


    def create_loadbalancer(
        self,
        datacenter_id: str,
        name: str,
        algorithm: str = "ROUND_ROBIN",
        ip: Optional[str] = None,
    ) -> str:
        """Create a load balancer inside the datacenter."""
        payload = {"properties": {"name": name, "lbAlgorithm": algorithm}}
        if ip:
            payload["properties"]["ip"] = ip

        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/loadbalancers",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("creating load balancer", data)
        return f"⚖️  Load balancer creation requested: **{name}** ({algorithm})"


    # ------------------------------------------------------------------
    # CREATE A NIC FOR A SERVER
    # ------------------------------------------------------------------
    def create_nic(
        self,
        datacenter_id: str,
        server_id: str,
        lan_id: int,
        name: str = "nic0",
        dhcp: bool = True,
        ips: Optional[list[str]] = None,
    ) -> str:
        """Add a NIC to a server and optionally assign static IPs."""
        payload = {"properties": {"name": name, "lan": lan_id, "dhcp": dhcp}}
        if ips:
            payload["properties"]["ips"] = ips

        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers/{server_id}/nics",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("creating NIC", data)
        return f"🧩 NIC `{name}` created on server `{server_id}` (LAN {lan_id}, DHCP={dhcp})."


    # ------------------------------------------------------------------
    # CREATE A INTERNET ACCESS FOR A LAN
    # ------------------------------------------------------------------
    def create_internet_access(self, datacenter_id: str, lan_id: int) -> str:
        """
        Enable Internet access on a LAN — this provides outbound connectivity.
        """
        payload = {"properties": {"lanId": lan_id}}
        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/internet-accesses",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("enabling Internet access", data)
        return f"🌍 Internet access enabled for LAN {lan_id}."


    # ------------------------------------------------------------------
    # FIREWALL RULES
    # ------------------------------------------------------------------
    def set_firewall_rules(
        self,
        datacenter_id: str,
        server_id: str,
        nic_id: str,
        rules: list[dict],
        replace_existing: bool = False,
    ) -> str:
        """
        Create or replace firewall rules for a NIC.
        `rules` is a list of dicts, each with protocol, sourceIp, portRangeStart, etc.
        Example rule:
        {
        "name": "allow-ssh",
        "protocol": "TCP",
        "portRangeStart": 22,
        "portRangeEnd": 22,
        "sourceIp": "0.0.0.0/0"
        }
        """
        # Replace all existing rules if requested
        if replace_existing:
            self._request(
                "delete",
                f"datacenters/{datacenter_id}/servers/{server_id}/nics/{nic_id}/firewallrules",
                expected=(202, 204),
            )

        results = []
        for rule in rules:
            ok, data = self._request(
                "post",
                f"datacenters/{datacenter_id}/servers/{server_id}/nics/{nic_id}/firewallrules",
                expected=(202,),
                json_body={"properties": rule},
            )
            if not ok:
                results.append(f"❌ Failed to add rule `{rule.get('name')}`: {self._stringify(data)}")
            else:
                results.append(f"🛡️  Firewall rule added: {rule.get('name')}")
        return "\n".join(results)


    # ------------------------------------------------------------------
    # HIGHER-LEVEL PROVISIONING LOGIC
    # ------------------------------------------------------------------

    def provision_server_with_network(
        self,
        datacenter_id: str,
        name: str,
        lan_name: str = "default-lan",
        volume_size_gb: int = 20,
        firewall_open_ports: list[int] = [22, 80, 443],
    ) -> str:
        """
        One-call provisioning:
        - Creates a LAN
        - Creates a server
        - Adds a NIC
        - Attaches a volume
        - Enables Internet access
        - Configures firewall
        """
        summary = [f"🚀 Provisioning server **{name}** in DC {datacenter_id}"]

        # 1. Create LAN
        lan_resp = self._request(
            "post",
            f"datacenters/{datacenter_id}/lans",
            expected=(202,),
            json_body={"properties": {"name": lan_name, "public": False}},
        )
        if not lan_resp[0]:
            return self._format_error("creating LAN", lan_resp[1])
        lan_id = lan_resp[1].get("id")
        summary.append(f"🌐 LAN created: {lan_name} (id={lan_id})")

        # 2. Create Server
        srv_resp = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers",
            expected=(202,),
            json_body={"properties": {"name": name, "cores": 2, "ram": 4096}},
        )
        if not srv_resp[0]:
            return self._format_error("creating server", srv_resp[1])
        server_id = srv_resp[1].get("id")
        summary.append(f"🖥️  Server created: {name} (id={server_id})")

        # 3. Create Volume + attach
        vol_resp = self._request(
            "post",
            f"datacenters/{datacenter_id}/volumes",
            expected=(202,),
            json_body={
                "properties": {
                    "name": f"{name}-disk",
                    "size": volume_size_gb,
                    "type": "HDD",
                    "licenceType": "LINUX",
                }
            },
        )
        if not vol_resp[0]:
            return self._format_error("creating volume", vol_resp[1])
        volume_id = vol_resp[1].get("id")
        summary.append(f"💽 Volume created: {name}-disk ({volume_size_gb} GB)")

        self.attach_volume_to_server(datacenter_id, server_id, volume_id)

        # 4. Create NIC on LAN
        nic_resp = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers/{server_id}/nics",
            expected=(202,),
            json_body={"properties": {"name": "nic0", "lan": int(lan_id), "dhcp": True}},
        )
        if not nic_resp[0]:
            return self._format_error("creating NIC", nic_resp[1])
        nic_id = nic_resp[1].get("id")
        summary.append(f"🧩 NIC added (id={nic_id})")

        # 5. Enable Internet access for LAN
        self.create_internet_access(datacenter_id, int(lan_id))
        summary.append(f"🌍 Internet access enabled for LAN {lan_id}")

        # 6. Firewall rules
        fw_rules = [
            {"name": f"allow-{p}", "protocol": "TCP", "portRangeStart": p, "portRangeEnd": p, "sourceIp": "0.0.0.0/0"}
            for p in firewall_open_ports
        ]
        self.set_firewall_rules(datacenter_id, server_id, nic_id, fw_rules)
        summary.append(f"🛡️  Firewall configured for ports: {firewall_open_ports}")

        return "\n".join(summary)

    # ------------------------------------------------------------------
    # ATTACH VOLUME TO SERVER
    # ------------------------------------------------------------------
    def attach_volume_to_server(
        self,
        datacenter_id: str,
        server_id: str,
        volume_id: str,
    ) -> str:
        """
        Attach an existing volume to a server.

        Equivalent to:
        POST /datacenters/{dc}/servers/{server}/volumes
        {
        "id": "<volume_id>"
        }
        """
        payload = {"id": volume_id}
        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers/{server_id}/volumes",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("attaching volume", data)

        props = data.get("properties", {})
        name = props.get("name", "<unnamed>")
        state = props.get("state", "<unknown>")
        size = props.get("size", "?")
        bus = props.get("bus", "?")
        return (
            f"💾 Volume **{name}** ({volume_id}, {size} GB on {bus}) attached to server `{server_id}`.\n"
            f"📦 Current state: {state}"
        )


    # ------------------------------------------------------------------
    # SERVER POWER CONTROL
    # ------------------------------------------------------------------
    def power_on_server(self, datacenter_id: str, server_id: str) -> str:
        """Start the given server."""
        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers/{server_id}/start",
            expected=(202,),
        )
        if not ok:
            return self._format_error("powering on server", data)
        return f"🟢 Power-on request accepted for server `{server_id}`."


    # ------------------------------------------------------------------
    # ASSIGN PUBLIC IP
    # ------------------------------------------------------------------
    def assign_public_ip(
        self, datacenter_id: str, server_id: str, nic_id: str, ip: str
    ) -> str:
        """
        Attach an existing reserved IP to a NIC.
        Equivalent to: PUT /servers/{server}/nics/{nic}/ips/{ip}
        """
        payload = {"ips": [ip]}
        ok, data = self._request(
            "put",
            f"datacenters/{datacenter_id}/servers/{server_id}/nics/{nic_id}",
            expected=(202,),
            json_body={"properties": payload},
        )
        if not ok:
            return self._format_error("assigning public IP", data)
        return f"🌍 Public IP `{ip}` assigned to NIC `{nic_id}` of server `{server_id}`."


    # ------------------------------------------------------------------
    # FIREWALL MANAGEMENT
    # ------------------------------------------------------------------
    def add_firewall_rules(
        self,
        datacenter_id: str,
        server_id: str,
        nic_id: str,
        rules: list[dict],
    ) -> str:
        """
        Add one or more firewall rules to a NIC.
        Example rule:
        {
        "name": "allow-http",
        "protocol": "TCP",
        "portRangeStart": 80,
        "portRangeEnd": 80,
        "sourceIp": "0.0.0.0/0"
        }
        """
        results = []
        for rule in rules:
            ok, data = self._request(
                "post",
                f"datacenters/{datacenter_id}/servers/{server_id}/nics/{nic_id}/firewallrules",
                expected=(202,),
                json_body={"properties": rule},
            )
            if not ok:
                results.append(f"❌ {rule.get('name')} → {self._stringify(data)}")
            else:
                results.append(f"🛡️  Added rule: {rule.get('name')} ({rule.get('protocol')}:{rule.get('portRangeStart')})")
        return "\n".join(results)


    # ------------------------------------------------------------------
    # RESIZE VOLUME
    # ------------------------------------------------------------------
    def resize_volume(self, datacenter_id: str, volume_id: str, new_size_gb: int) -> str:
        """Increase the size of a volume."""
        payload = {"properties": {"size": new_size_gb}}
        ok, data = self._request(
            "patch",
            f"datacenters/{datacenter_id}/volumes/{volume_id}",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("resizing volume", data)
        return f"📏 Resize requested for volume `{volume_id}` → {new_size_gb} GB."


    # ------------------------------------------------------------------
    # CREATE BOOTABLE SERVER (AUTO SSH KEY)
    # ------------------------------------------------------------------
    def create_bootable_ubuntu_server(
        self,
        datacenter_id: str,
        name: str = "ubuntu-server",
        image_alias: str = "ubuntu:22.04",
        cores: int = 2,
        ram_mb: int = 4096,
        volume_size_gb: int = 40,
        lan_name: str = "default-lan",
        public: bool = True,
        auto_power_on: bool = True,
    ) -> str:
        """
        Creates a fully bootable Ubuntu server using the default SSH key(s)
        already registered in IONOS DCD. Automatically creates:
        - LAN (if not exists)
        - Server + bootable volume
        - Internet access (if public=True)
        - Power-on (optional)
        """

        summary = [f"🚀 Creating bootable Ubuntu server **{name}**"]

        # --- Step 1: Ensure LAN exists ---
        ok, lans = self._request("get", f"datacenters/{datacenter_id}/lans", params={"depth": 2})
        if not ok:
            return self._format_error("retrieving LANs", lans)

        existing_lan = next((l for l in lans.get("items", []) if l["properties"].get("name") == lan_name), None)
        if existing_lan:
            lan_id = existing_lan["id"]
            summary.append(f"🌐 Using existing LAN: {lan_name} (id={lan_id})")
        else:
            ok, newlan = self._request(
                "post",
                f"datacenters/{datacenter_id}/lans",
                expected=(202,),
                json_body={"properties": {"name": lan_name, "public": public}},
            )
            if not ok:
                return self._format_error("creating LAN", newlan)
            lan_id = newlan.get("id")
            summary.append(f"🌐 Created LAN: {lan_name} (id={lan_id})")

        # --- Step 2: Create the bootable server ---
        payload = {
            "properties": {
                "name": name,
                "cores": cores,
                "ram": ram_mb,
                "availabilityZone": "AUTO",
            },
            "entities": {
                "volumes": [
                    {
                        "properties": {
                            "name": f"{name}-boot",
                            "size": volume_size_gb,
                            "type": "HDD",
                            "imageAlias": image_alias,
                            "licenceType": "LINUX",
                            "bootVolume": True,
                            # SSH key omitted → default key used
                        }
                    }
                ],
                "nics": [
                    {
                        "properties": {
                            "name": "nic0",
                            "lan": int(lan_id),
                            "dhcp": True,
                        }
                    }
                ],
            },
        }

        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("creating bootable server", data)

        server_id = data.get("id")
        vol_props = (
            data.get("entities", {})
            .get("volumes", {})
            .get("items", [{}])[0]
            .get("properties", {})
        )
        summary.append(
            f"🖥️  Server **{name}** created (id={server_id}) "
            f"with {cores} cores / {ram_mb} MB RAM."
        )
        summary.append(
            f"💽 Boot disk: {vol_props.get('name')} ({vol_props.get('size')} GB, {vol_props.get('imageAlias')})"
        )

        # --- Step 3: Enable Internet access if requested ---
        if public:
            self.create_internet_access(datacenter_id, int(lan_id))
            summary.append(f"🌍 Internet access enabled for LAN {lan_id}")

        # --- Step 4: Power on ---
        if auto_power_on:
            self.power_on_server(datacenter_id, server_id)
            summary.append(f"🟢 Server powered on.")

        summary.append("🔑 Default SSH key(s) from your IONOS account will be used.")
        summary.append("💡 You can now SSH to the server once the public IP is assigned.")

        return "\n".join(summary)


    # ------------------------------------------------------------------
    # CREATE DEFAULT SERVER (Ubuntu + SSH + Power ON)
    # ------------------------------------------------------------------

    def create_default_server(
        self,
        datacenter_id: str,
        name: str = "default-ubuntu-server",
        image_alias: str = "ubuntu:24.04",  # latest LTS at time of writing
        lan_name: str = "default-lan",
        public: bool = True,
    ) -> str:
        """
        Quickly create a standard Ubuntu server:
        - 4 vCPUs / 4 GB RAM / 40 GB HDD
        - Ubuntu latest (default image_alias)
        - Uses default SSH key(s) from your IONOS account
        - Automatically bootable and powered on
        - LAN + Internet access automatically configured
        """

        summary = [f"🚀 Creating default Ubuntu server **{name}** in datacenter {datacenter_id}"]

        # Step 1: Ensure LAN exists
        ok, lans = self._request("get", f"datacenters/{datacenter_id}/lans", params={"depth": 2})
        if not ok:
            return self._format_error("retrieving LANs", lans)

        existing_lan = next((l for l in lans.get("items", []) if l["properties"].get("name") == lan_name), None)
        if existing_lan:
            lan_id = existing_lan["id"]
            summary.append(f"🌐 Using existing LAN: {lan_name} (id={lan_id})")
        else:
            ok, newlan = self._request(
                "post",
                f"datacenters/{datacenter_id}/lans",
                expected=(202,),
                json_body={"properties": {"name": lan_name, "public": public}},
            )
            if not ok:
                return self._format_error("creating LAN", newlan)
            lan_id = newlan.get("id")
            summary.append(f"🌐 Created LAN: {lan_name} (id={lan_id})")

        # Step 2: Create bootable server
        payload = {
            "properties": {
                "name": name,
                "cores": 4,
                "ram": 4096,
                "availabilityZone": "AUTO",
            },
            "entities": {
                "volumes": {
                    "items": [
                        {
                            "properties": {
                                "name": f"{name}-boot",
                                "size": 40,
                                "type": "HDD",
                                "imageAlias": image_alias,
                                "licenceType": "LINUX",
                                "bootVolume": True,
                                # SSH key omitted → default used
                            }
                        }
                    ]
                },
                "nics": {
                    "items": [
                        {
                            "properties": {
                                "name": "nic0",
                                "lan": int(lan_id),
                                "dhcp": True,
                            }
                        }
                    ]
                },
            },
        }


        ok, data = self._request(
            "post",
            f"datacenters/{datacenter_id}/servers",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("creating default server", data)

        server_id = data.get("id")
        summary.append(f"🖥️  Server **{name}** created (id={server_id}) with 4 vCPUs / 4 GB RAM")
        summary.append("💽 Boot volume: 40 GB HDD (Ubuntu latest)")
        summary.append("🔑 Default SSH key(s) from your IONOS account will be used")

        # Step 3: Enable Internet access
        if public:
            self.create_internet_access(datacenter_id, int(lan_id))
            summary.append(f"🌍 Internet access enabled for LAN {lan_id}")

        # Step 4: Power ON
        self.power_on_server(datacenter_id, server_id)
        summary.append("🟢 Server powered on and ready to SSH")

        return "\n".join(summary)


    # ------------------------------------------------------------------
    # SET EXISTING VOLUME AS BOOTABLE
    # ------------------------------------------------------------------
    def set_boot_volume(
        self,
        datacenter_id: str,
        server_id: str,
        volume_id: str,
    ) -> str:
        """
        Set an existing attached volume as the boot device for a server.

        Equivalent to:
        PATCH /datacenters/{dcId}/servers/{serverId}
        { "properties": { "bootVolume": { "id": "<volumeId>" } } }
        """
        payload = {"properties": {"bootVolume": {"id": volume_id}}}

        ok, data = self._request(
            "patch",
            f"datacenters/{datacenter_id}/servers/{server_id}",
            expected=(202,),
            json_body=payload,
        )
        if not ok:
            return self._format_error("setting boot volume", data)

        return (
            f"💽 Volume `{volume_id}` has been set as the boot device "
            f"for server `{server_id}`.\n"
            f"🔁 You may need to reboot the server for the change to take effect."
        )
