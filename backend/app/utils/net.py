"""Outbound-URL safety (SSRF guard).

Tenant-influenced URLs (e.g. the ΗΔΥΚΑ `base_url`) are sent authenticated requests that
carry the platform Api-Key. Without a guard a tenant could point them at internal services
(http://vault:8200, http://169.254.169.254, the Mongo host, …) and exfiltrate the key or
probe the private network (M2). This restricts such URLs to PUBLIC http(s) hosts only.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class UnsafeUrlError(ValueError):
    """Raised when a URL is not a safe public outbound target."""


def assert_safe_outbound_url(url: str, *, allowed_host_suffixes: list[str] | None = None) -> None:
    """Raise UnsafeUrlError unless `url` is http(s) to a PUBLIC host. Rejects loopback,
    private, link-local, reserved and multicast addresses (and hostnames that resolve to
    them, fail-closed on resolution failure). If `allowed_host_suffixes` is given, the host
    must equal or be a subdomain of one of them (defense-in-depth pinning)."""
    p = urlparse((url or "").strip())
    if p.scheme not in ("http", "https"):
        raise UnsafeUrlError(f"μη έγκυρο scheme: {p.scheme or '—'}")
    host = p.hostname
    if not host:
        raise UnsafeUrlError("λείπει host")

    if allowed_host_suffixes:
        if not any(host == s or host.endswith("." + s) for s in allowed_host_suffixes):
            raise UnsafeUrlError(f"host εκτός allow-list: {host}")

    # Resolve to candidate IPs (literal host → itself; hostname → all A/AAAA records).
    try:
        candidates = [ipaddress.ip_address(host)]
    except ValueError:
        port = p.port or (443 if p.scheme == "https" else 80)
        try:
            infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        except socket.gaierror as exc:
            raise UnsafeUrlError(f"αδυναμία ανάλυσης host: {host}") from exc
        candidates = [ipaddress.ip_address(info[4][0]) for info in infos]

    for addr in candidates:
        if not addr.is_global:
            raise UnsafeUrlError(f"ο host {host} δείχνει σε μη-δημόσια διεύθυνση {addr}")
