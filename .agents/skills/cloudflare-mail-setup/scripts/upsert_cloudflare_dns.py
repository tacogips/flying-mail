#!/usr/bin/env python3
"""Idempotently create or update one Cloudflare DNS record."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API_BASE = "https://api.cloudflare.com/client/v4"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create or update one unambiguous Cloudflare DNS record."
    )
    parser.add_argument("zone", help="Active Cloudflare zone name")
    parser.add_argument("record_type", help="DNS record type, such as TXT")
    parser.add_argument("name", help="Fully qualified DNS record name")
    parser.add_argument("content", help="DNS record content (never printed)")
    parser.add_argument("--ttl", type=int, default=60)
    parser.add_argument("--priority", type=int)
    return parser.parse_args()


def cloudflare_request(
    token: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode()
    request = Request(
        f"{API_BASE}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            decoded = json.load(response)
    except HTTPError as error:
        try:
            decoded = json.load(error)
            errors = decoded.get("errors", [])
        except (json.JSONDecodeError, AttributeError):
            errors = [{"code": error.code, "message": error.reason}]
        raise RuntimeError(f"Cloudflare API rejected the request: {errors}") from error
    except URLError as error:
        raise RuntimeError(f"Cloudflare API request failed: {error.reason}") from error

    if not isinstance(decoded, dict) or decoded.get("success") is not True:
        errors = decoded.get("errors", []) if isinstance(decoded, dict) else []
        raise RuntimeError(f"Cloudflare API returned an error: {errors}")
    return decoded


def result_list(response: dict[str, Any]) -> list[dict[str, Any]]:
    result = response.get("result")
    if not isinstance(result, list) or not all(
        isinstance(item, dict) for item in result
    ):
        raise RuntimeError("Cloudflare API returned an unexpected result shape")
    return result


def main() -> int:
    args = parse_args()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        print(
            "CLOUDFLARE_API_TOKEN is required; inject it with kinko exec",
            file=sys.stderr,
        )
        return 3
    if args.ttl < 1:
        print("--ttl must be positive", file=sys.stderr)
        return 2

    zones = result_list(
        cloudflare_request(
            token,
            "GET",
            f"/zones?{urlencode({'name': args.zone, 'status': 'active', 'per_page': 50})}",
        )
    )
    if len(zones) != 1:
        raise RuntimeError(
            f"Expected exactly one active Cloudflare zone named {args.zone}; "
            f"found {len(zones)}"
        )
    zone_id = zones[0].get("id")
    if not isinstance(zone_id, str) or not zone_id:
        raise RuntimeError("Cloudflare zone result has no id")

    records = result_list(
        cloudflare_request(
            token,
            "GET",
            f"/zones/{zone_id}/dns_records?"
            + urlencode(
                {
                    "type": args.record_type.upper(),
                    "name": args.name,
                    "per_page": 50,
                }
            ),
        )
    )
    if len(records) > 1:
        raise RuntimeError(
            f"Refusing to update {args.name}: found {len(records)} matching records"
        )

    payload: dict[str, Any] = {
        "type": args.record_type.upper(),
        "name": args.name,
        "content": args.content,
        "ttl": args.ttl,
    }
    if args.priority is not None:
        payload["priority"] = args.priority

    if records:
        record_id = records[0].get("id")
        if not isinstance(record_id, str) or not record_id:
            raise RuntimeError("Cloudflare DNS record result has no id")
        response = cloudflare_request(
            token, "PUT", f"/zones/{zone_id}/dns_records/{record_id}", payload
        )
        action = "updated"
    else:
        response = cloudflare_request(
            token, "POST", f"/zones/{zone_id}/dns_records", payload
        )
        action = "created"

    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("Cloudflare API returned an unexpected DNS result")
    safe_result = {
        "action": action,
        "id": result.get("id"),
        "type": result.get("type"),
        "name": result.get("name"),
        "ttl": result.get("ttl"),
    }
    print(json.dumps(safe_result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(4) from error
