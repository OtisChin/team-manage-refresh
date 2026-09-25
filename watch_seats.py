"""持续采样某个 Team 的官方席位快照，用来观察 held（On hold）席位何时被释放。

用法（在项目根目录执行）：

    docker compose exec -T app python watch_seats.py --team-id 5 --hours 24 --interval 900

采样结果追加写入脚本同目录下的 ``seat_watch.jsonl``，每行一个 JSON：
``{"ts": "...", "team_id": 5, "prolite": {"paid":..,"held":..,"available":..,"assigned":..}, ...}``

只在 held / available / paid 发生变化时才打印醒目提示，避免刷屏。
"""

import argparse
import asyncio
import json
import os
from datetime import datetime, timedelta

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models import Team
from app.services.chatgpt import ChatGPTService
from app.services.team import TeamService

OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seat_watch.jsonl")
# normalize_seat_snapshot 里已购总数用的键名是 total（对应官方 seat_capacity 的 paid）
WATCHED_KEYS = ("total", "held", "available", "assigned")
LABELS = {"total": "paid"}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _load_last_snapshot() -> dict:
    """读取最后一次快照，用于比较变化。"""
    if not os.path.exists(OUTPUT):
        return {}
    last = {}
    try:
        with open(OUTPUT, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict):
                    last[str(record.get("team_id"))] = record
    except OSError:
        return {}
    return last


async def sample(team_id: int) -> dict:
    chatgpt = ChatGPTService()
    team_service = TeamService()
    async with AsyncSessionLocal() as db:
        team = (await db.execute(select(Team).where(Team.id == team_id))).scalar_one_or_none()
        if team is None:
            return {"error": f"team {team_id} 不存在"}
        token = await team_service.ensure_access_token(team, db)
        if not token:
            return {"error": "无法获取 access_token"}
        url = f"{chatgpt.BASE_URL}/subscriptions?account_id={team.account_id}"
        headers = {
            "Authorization": f"Bearer {token}",
            "chatgpt-account-id": team.account_id,
        }
        result = await chatgpt._make_request(
            "GET", url, headers, db_session=db, identifier=f"seat_watch_{team_id}"
        )
        if not result["success"]:
            return {"error": result.get("error") or "请求失败", "status_code": result.get("status_code")}

        raw = result["data"]
        snapshot = chatgpt.normalize_seat_snapshot(raw)
        seats = snapshot["seat_types"]
        return {
            "ts": _now(),
            "team_id": team_id,
            "email": team.email,
            "team_status": team.status,
            "seats_entitled": snapshot["seats_entitled"],
            "seats_in_use": snapshot["seats_in_use"],
            "active_until": snapshot["active_until"],
            "default": {k: seats.get("default", {}).get(k, 0) for k in WATCHED_KEYS},
            "prolite": {k: seats.get("prolite", {}).get(k, 0) for k in WATCHED_KEYS},
        }


def _diff(previous: dict, current: dict) -> list:
    changes = []
    for seat_type in ("default", "prolite"):
        before = previous.get(seat_type) or {}
        after = current.get(seat_type) or {}
        for key in WATCHED_KEYS:
            old, new = before.get(key), after.get(key)
            if old is not None and old != new:
                changes.append(f"{seat_type}.{LABELS.get(key, key)}: {old} -> {new}")
    return changes


async def run(team_ids, interval: int, hours: float) -> None:
    deadline = datetime.now() + timedelta(hours=hours) if hours > 0 else None
    last = _load_last_snapshot()
    print(f"[{_now()}] 开始采样 teams={team_ids} interval={interval}s hours={hours} -> {OUTPUT}")
    while True:
        for team_id in team_ids:
            record = await sample(team_id)
            if "error" in record:
                print(f"[{_now()}] team {team_id} 采样失败: {record['error']}")
                continue
            with open(OUTPUT, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            changes = _diff(last.get(str(team_id), {}), record)
            prolite = record["prolite"]
            line = (
                f"[{record['ts']}] team {team_id} prolite paid={prolite['total']} "
                f"assigned={prolite['assigned']} available={prolite['available']} held={prolite['held']}"
            )
            if changes:
                print(f"*** 席位变化 *** {'; '.join(changes)}")
                print(line)
            else:
                print(line)
            last[str(team_id)] = record
        if deadline and datetime.now() + timedelta(seconds=interval) > deadline:
            print(f"[{_now()}] 到达采样截止时间，结束")
            return
        await asyncio.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(description="持续采样 Team 席位快照，观察 held 席位释放")
    parser.add_argument("--team-id", type=int, nargs="+", default=[5], help="要采样的 Team ID，可多个")
    parser.add_argument("--interval", type=int, default=900, help="采样间隔秒数，默认 900")
    parser.add_argument("--hours", type=float, default=24.0, help="持续小时数，0 表示不限")
    args = parser.parse_args()
    asyncio.run(run(args.team_id, args.interval, args.hours))


if __name__ == "__main__":
    main()
