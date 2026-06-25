"""Re-apply the (admin-configurable) markup scale to all stored items & executions.
Reads the platform-global bands (platform_settings._id="markup", else default). Idempotent."""
import asyncio

from app.core.db import shared_db
from app.services.wholesale import load_bands, recompute


async def main() -> None:
    db = shared_db()
    bands = await load_bands(db)
    res = await recompute(db, bands)
    print(res)


if __name__ == "__main__":
    asyncio.run(main())
