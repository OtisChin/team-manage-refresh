import unittest
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import Team, TeamEmailMapping
from app.services.chatgpt import ChatGPTService
from app.services.team import TeamService

# 取自真实 HAR：Business 工作区买了 2 个 Standard 席位，已用 1 个
REAL_SUBSCRIPTION_PAYLOAD = {
    "seats_in_use": 1,
    "seats_entitled": 2,
    "seat_capacity": [
        {"type": "default", "paid": 2, "held": 0, "available": 1},
        {"type": "prolite", "paid": 0, "held": 0, "available": 0},
    ],
    "assigned": {"default": 1, "usage_based": 0, "automation": 0, "prolite": 0},
    "active_until": "2026-10-03T17:45:43Z",
}


class TeamImportNormalizationTests(unittest.TestCase):
    def test_cli_proxy_api_flat_auth_file(self):
        item = {
            "type": "codex",
            "access_token": " at-flat ",
            "refresh_token": "rt-flat",
            "id_token": "id-flat",
            "account_id": "account-flat",
            "email": "flat@example.com",
            "expired": "2026-08-12T12:00:00+08:00",
        }

        self.assertEqual(
            TeamService._normalize_team_import_item(item),
            {
                "access_token": "at-flat",
                "id_token": "id-flat",
                "refresh_token": "rt-flat",
                "session_token": None,
                "client_id": None,
                "email": "flat@example.com",
                "account_id": "account-flat",
            },
        )

    def test_nested_token_object_and_metadata_are_supported(self):
        item = {
            "type": "codex",
            "metadata": {
                "email": "nested@example.com",
                "token": {
                    "access_token": "at-nested",
                    "refresh_token": "rt-nested",
                    "id_token": "id-nested",
                    "chatgpt_account_id": "account-nested",
                },
            },
        }

        normalized = TeamService._normalize_team_import_item(item)
        self.assertEqual(normalized["access_token"], "at-nested")
        self.assertEqual(normalized["refresh_token"], "rt-nested")
        self.assertEqual(normalized["id_token"], "id-nested")
        self.assertEqual(normalized["email"], "nested@example.com")
        self.assertEqual(normalized["account_id"], "account-nested")

    def test_legacy_string_token_is_treated_as_access_token(self):
        normalized = TeamService._normalize_team_import_item(
            {"token": "at-legacy", "email": "legacy@example.com"}
        )

        self.assertEqual(normalized["access_token"], "at-legacy")
        self.assertEqual(normalized["email"], "legacy@example.com")

    def test_unrelated_json_object_is_ignored(self):
        self.assertIsNone(TeamService._normalize_team_import_item({"type": "codex"}))


class ImportTeamSingleTests(unittest.IsolatedAsyncioTestCase):
    """端到端跑一遍 import_team_single。

    这条路径曾经漏测：把兜底席位读取抽成独立方法后，方法里引用的
    ``settings_service`` 只在原函数内局部导入，导致真实导入时报
    ``name 'settings_service' is not defined``，而单测全绿。
    """

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session_factory = async_sessionmaker(
            self.engine, class_=AsyncSession, expire_on_commit=False
        )

    async def asyncTearDown(self):
        await self.engine.dispose()

    @staticmethod
    def _stub_account_info(account_id="acct-import-1"):
        async def stub(*args, **kwargs):
            return {
                "success": True,
                "accounts": [
                    {
                        "account_id": account_id,
                        "name": "ImportOrg",
                        "plan_type": "team",
                        "account_user_role": "account-owner",
                        "subscription_plan": "chatgptteamplan",
                        "expires_at": "2026-10-03T17:45:43Z",
                        "has_active_subscription": True,
                    }
                ],
                "error": None,
            }

        return stub

    @staticmethod
    def _stub_members():
        async def stub(*args, **kwargs):
            return {
                "success": True,
                "members": [
                    {"id": "u1", "email": "owner@example.com", "name": "Owner", "seat_type": "default"},
                    {"id": "u2", "email": "member@example.com", "name": "Member", "seat_type": "default"},
                ],
                "total": 2,
                "error": None,
            }

        return stub

    @staticmethod
    def _stub_invites():
        async def stub(*args, **kwargs):
            return {
                "success": True,
                "items": [
                    {
                        "email_address": "pending@example.com",
                        "role": "standard-user",
                        "status": 2,
                        "state": "pending",
                        "seat_type": "prolite",
                    }
                ],
                "total": 1,
                "error": None,
            }

        return stub

    @staticmethod
    def _stub_account_settings():
        async def stub(*args, **kwargs):
            return {"success": True, "data": {"beta_settings": {}}, "error": None}

        return stub

    @staticmethod
    def _stub_subscription(success=True):
        async def stub(*args, **kwargs):
            if not success:
                return {
                    "success": False,
                    "seats_entitled": None,
                    "seats_in_use": None,
                    "seat_types": {},
                    "active_until": None,
                    "error": "boom",
                }
            return {
                "success": True,
                "error": None,
                **ChatGPTService.normalize_seat_snapshot(REAL_SUBSCRIPTION_PAYLOAD),
            }

        return stub

    @staticmethod
    def _stub_hydrate():
        async def stub(**kwargs):
            return {
                "access_token": kwargs.get("access_token"),
                "refresh_token": kwargs.get("refresh_token"),
                "session_token": kwargs.get("session_token"),
                "id_token": kwargs.get("id_token") or "id-token",
            }

        return stub

    def _patched(self, service, subscription_success=True, account_id="acct-import-1"):
        return [
            patch.object(service.jwt_parser, "is_token_expired", return_value=False),
            patch.object(service.jwt_parser, "extract_email", return_value="owner@example.com"),
            patch.object(service, "_hydrate_missing_id_token", new=self._stub_hydrate()),
            patch.object(service.chatgpt_service, "get_account_info", new=self._stub_account_info(account_id)),
            patch.object(service.chatgpt_service, "get_members", new=self._stub_members()),
            patch.object(service.chatgpt_service, "get_invites", new=self._stub_invites()),
            patch.object(service.chatgpt_service, "get_account_settings", new=self._stub_account_settings()),
            patch.object(
                service.chatgpt_service,
                "get_subscription",
                new=self._stub_subscription(subscription_success),
            ),
        ]

    async def test_import_uses_real_seats_from_subscription(self):
        service = TeamService()
        patches = self._patched(service)
        for p in patches:
            p.start()
        try:
            async with self.session_factory() as session:
                result = await service.import_team_single(
                    access_token="at",
                    db_session=session,
                    account_id="acct-import-1",
                    pool_type="normal",
                )
        finally:
            for p in patches:
                p.stop()

        self.assertTrue(result["success"], result)

        async with self.session_factory() as session:
            teams = (await session.execute(select(Team))).scalars().all()
            self.assertEqual(len(teams), 1)
            team = teams[0]
            # 总席位取真实 seats_entitled，而不是写死的 6
            self.assertEqual(team.account_id, "acct-import-1")
            self.assertEqual(team.max_members, 2)
            self.assertEqual(team.seats_default_total, 2)
            self.assertEqual(team.seats_default_assigned, 1)
            self.assertEqual(team.seats_default_available, 1)
            self.assertEqual(team.seats_prolite_total, 0)
            self.assertIsNotNone(team.seats_synced_at)

            # 导入时的成员口径与同步一致：已加入 2 人，待接受 1 人
            self.assertEqual(team.current_members, 2)
            self.assertEqual(team.pending_members, 1)

            # 导入时必须立刻建立成员映射，否则自动踢人的
            # "非授权成员清退 / 后台邀请过期" 两条策略扫不到任何候选
            mappings = (
                await session.execute(
                    select(TeamEmailMapping).where(TeamEmailMapping.team_id == team.id)
                )
            ).scalars().all()
            status_by_email = {m.email: m.status for m in mappings}
            self.assertEqual(status_by_email.get("owner@example.com"), "joined")
            self.assertEqual(status_by_email.get("member@example.com"), "joined")
            self.assertEqual(status_by_email.get("pending@example.com"), "invited")

    async def test_import_falls_back_to_default_when_subscription_unavailable(self):
        service = TeamService()
        patches = self._patched(service, subscription_success=False, account_id="acct-import-2")
        for p in patches:
            p.start()
        try:
            async with self.session_factory() as session:
                result = await service.import_team_single(
                    access_token="at",
                    db_session=session,
                    account_id="acct-import-2",
                    pool_type="normal",
                )
        finally:
            for p in patches:
                p.stop()

        self.assertTrue(result["success"], result)

        async with self.session_factory() as session:
            teams = (
                await session.execute(select(Team).where(Team.account_id == "acct-import-2"))
            ).scalars().all()
            self.assertEqual(len(teams), 1)
            team = teams[0]
            # 读不到真实席位时回退到系统设置里的兜底值
            self.assertEqual(team.max_members, TeamService.DEFAULT_TEAM_MAX_MEMBERS)
            self.assertIsNone(team.seats_synced_at)


if __name__ == "__main__":
    unittest.main()
