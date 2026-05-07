from __future__ import annotations

from typing import Any

import httpx


class ArcadeDBClient:
    def __init__(self, url: str, database: str, user: str, password: str) -> None:
        self.url = url.rstrip("/")
        self.database = database
        self.auth = (user, password)

    async def server_ready(self) -> bool:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{self.url}/api/v1/server", auth=self.auth)
            return response.status_code < 500

    async def command(
        self,
        language: str,
        command: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        body: dict[str, Any] = {"language": language, "command": command}
        if params:
            body["params"] = params
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.url}/api/v1/command/{self.database}",
                auth=self.auth,
                json=body,
            )
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict):
            return []
        result = data.get("result", [])
        return [item for item in result if isinstance(item, dict)] if isinstance(result, list) else []
