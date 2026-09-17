"""席位同步相关测试。

覆盖：
- ``GET /subscriptions`` 响应的归一化（按 default=普通 / prolite=高级 席型拆分）
- 席位快照写入 Team（max_members 跟随真实 seats_entitled）
- 已读到真实席位后，"席位已满"错误不再反向改写 max_members
"""

import unittest
from unittest.mock import AsyncMock, patch

from app.models import Team
from app.services.chatgpt import ChatGPTService
from app.services.team import TeamService

# 取自真实 HAR（chatgpt.com.har）：Business 工作区买了 2 个 Standard 席位，已用 1 个
REAL_SUBSCRIPTION_PAYLOAD = {
    "id": "7c8f2ee4-1181-4b7d-a9cc-9c6503971257",
    "plan_type": "team",
    "seats_in_use": 1,
    "seats_entitled": 2,
    "seat_capacity": [
        {
            "type": "default",
            "paid": 2,
            "held": 0,
            "renewal_requested": 2,
            "available": 1,
            "pending_unoccupied_removal": 0,
            "pending_occupied_downgrades": [],
            "pending_unoccupied_downgrades": [],
        },
        {
            "type": "prolite",
            "paid": 0,
            "held": 0,
            "renewal_requested": 0,
            "available": 0,
            "pending_unoccupied_removal": 0,
            "pending_occupied_downgrades": [],
            "pending_unoccupied_downgrades": [],
        },
    ],
    "assigned": {"default": 1, "usage_based": 0, "automation": 0, "prolite": 0},
    "active_start": "2026-09-03T17:45:43Z",
    "active_until": "2026-10-03T17:45:43Z",
    "billing_period": "monthly",
    "will_renew": True,
}


class GetSubscriptionRequestTests(unittest.IsolatedAsyncioTestCase):
    """/subscriptions 必须带 account_id 查询参数，否则 Bearer 鉴权会 400。"""

    async def test_requests_subscription_with_account_id_query_param(self):
        service = ChatGPTService()
        captured = {}

        async def fake_make_request(method, url, headers, json_data=None, db_session=None, identifier="default"):
            captured["method"] = method
            captured["url"] = url
            captured["headers"] = headers
            return {"success": True, "data": REAL_SUBSCRIPTION_PAYLOAD, "error": None}

        service._make_request = fake_make_request

        result = await service.get_subscription("token", "acc-123", db_session=None)

        self.assertTrue(result["success"])
        self.assertIn("/subscriptions?account_id=acc-123", captured["url"])
        self.assertEqual(captured["headers"]["chatgpt-account-id"], "acc-123")
        self.assertEqual(result["seats_entitled"], 2)

    async def test_returns_failure_payload_when_request_fails(self):
        service = ChatGPTService()

        async def fake_make_request(method, url, headers, json_data=None, db_session=None, identifier="default"):
            return {"success": False, "error": "must specify either organization_id or account_id", "status_code": 400}

        service._make_request = fake_make_request

        result = await service.get_subscription("token", "acc-123", db_session=None)

        self.assertFalse(result["success"])
        self.assertIsNone(result["seats_entitled"])
        self.assertEqual(result["seat_types"], {})


class NormalizeSeatSnapshotTests(unittest.TestCase):
    def test_splits_seats_by_type_from_real_payload(self):
        snapshot = ChatGPTService.normalize_seat_snapshot(REAL_SUBSCRIPTION_PAYLOAD)

        self.assertEqual(snapshot["seats_entitled"], 2)
        self.assertEqual(snapshot["seats_in_use"], 1)
        self.assertEqual(snapshot["active_until"], "2026-10-03T17:45:43Z")

        default_seat = snapshot["seat_types"]["default"]
        self.assertEqual(default_seat["total"], 2)
        self.assertEqual(default_seat["assigned"], 1)
        self.assertEqual(default_seat["available"], 1)

        prolite_seat = snapshot["seat_types"]["prolite"]
        self.assertEqual(prolite_seat["total"], 0)
        self.assertEqual(prolite_seat["assigned"], 0)
        self.assertEqual(prolite_seat["available"], 0)

    def test_derives_assigned_when_assigned_map_missing(self):
        payload = {
            "seats_entitled": 5,
            "seat_capacity": [{"type": "default", "paid": 5, "held": 1, "available": 1}],
        }

        snapshot = ChatGPTService.normalize_seat_snapshot(payload)

        # paid(5) - available(1) - held(1) = 3
        self.assertEqual(snapshot["seat_types"]["default"]["assigned"], 3)

    def test_derives_total_from_seat_capacity_when_seats_entitled_missing(self):
        payload = {
            "seat_capacity": [
                {"type": "default", "paid": 2, "held": 0, "available": 2},
                {"type": "prolite", "paid": 3, "held": 0, "available": 3},
            ]
        }

        snapshot = ChatGPTService.normalize_seat_snapshot(payload)

        self.assertEqual(snapshot["seats_entitled"], 5)

    def test_handles_empty_payload(self):
        snapshot = ChatGPTService.normalize_seat_snapshot({})

        self.assertEqual(snapshot["seats_entitled"], 0)
        self.assertEqual(snapshot["seat_types"], {})
        self.assertIsNone(snapshot["active_until"])


class ApplySeatSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.service = TeamService()

    def test_applies_real_seats_and_overrides_hardcoded_default(self):
        team = Team(email="owner@example.com", access_token_encrypted="x", max_members=6)
        snapshot = {"success": True, **ChatGPTService.normalize_seat_snapshot(REAL_SUBSCRIPTION_PAYLOAD)}

        applied = self.service._apply_seat_snapshot(team, snapshot)

        self.assertTrue(applied)
        self.assertEqual(team.max_members, 2)          # 不再是写死的 6
        self.assertEqual(team.seats_default_total, 2)
        self.assertEqual(team.seats_default_assigned, 1)
        self.assertEqual(team.seats_default_available, 1)
        self.assertEqual(team.seats_prolite_total, 0)
        self.assertEqual(team.seats_prolite_assigned, 0)
        self.assertIsNotNone(team.seats_synced_at)

    def test_failed_snapshot_keeps_existing_seats(self):
        team = Team(email="owner@example.com", access_token_encrypted="x", max_members=6)

        applied = self.service._apply_seat_snapshot(team, {"success": False, "error": "boom"})

        self.assertFalse(applied)
        self.assertEqual(team.max_members, 6)
        self.assertIsNone(team.seats_synced_at)

    def test_zero_entitled_seats_is_not_applied(self):
        team = Team(email="owner@example.com", access_token_encrypted="x", max_members=6)

        applied = self.service._apply_seat_snapshot(team, {"success": True, "seats_entitled": 0})

        self.assertFalse(applied)
        self.assertEqual(team.max_members, 6)

    def test_serialize_seat_fields_exposes_both_types(self):
        team = Team(email="owner@example.com", access_token_encrypted="x")
        team.seats_default_total = 2
        team.seats_default_assigned = 1
        team.seats_default_available = 1
        team.seats_prolite_total = 3
        team.seats_prolite_assigned = 2
        team.seats_prolite_available = 1

        payload = self.service._serialize_seat_fields(team)

        self.assertEqual(payload["seats_default_total"], 2)
        self.assertEqual(payload["seats_prolite_total"], 3)
        self.assertEqual(payload["seats_prolite_assigned"], 2)
        self.assertIsNone(payload["seats_synced_at"])


class FullSeatErrorHandlingTests(unittest.IsolatedAsyncioTestCase):
    """已读到真实席位后，撞墙学习不应再改写 max_members。"""

    async def test_does_not_shrink_max_members_when_seats_were_synced(self):
        service = TeamService()
        team = Team(
            email="owner@example.com",
            access_token_encrypted="x",
            current_members=2,
            max_members=5,
        )
        from app.utils.time_utils import get_now

        team.seats_synced_at = get_now()
        db_session = AsyncMock()

        handled = await service._handle_api_error(
            {"success": False, "error": "You have reached maximum number of seats"},
            team,
            db_session,
        )

        self.assertTrue(handled)
        self.assertEqual(team.status, "full")
        self.assertEqual(team.max_members, 5)  # 权威值不被撞墙结果覆盖

    async def test_shrinks_max_members_when_seats_never_synced(self):
        service = TeamService()
        team = Team(
            email="owner@example.com",
            access_token_encrypted="x",
            current_members=2,
            max_members=6,
        )
        db_session = AsyncMock()

        handled = await service._handle_api_error(
            {"success": False, "error": "You have reached maximum number of seats"},
            team,
            db_session,
        )

        self.assertTrue(handled)
        self.assertEqual(team.status, "full")
        self.assertEqual(team.max_members, 2)  # 兜底路径仍可反推容量


class SendInviteSeatTypeTests(unittest.IsolatedAsyncioTestCase):
    """邀请请求必须带上 seat_type（真实抓包 invite-default.har 确认的字段）。"""

    @staticmethod
    def _capture(service):
        captured = {}

        async def fake_make_request(method, url, headers, json_data=None, db_session=None, identifier="default"):
            captured["method"] = method
            captured["url"] = url
            captured["json"] = json_data
            return {"success": True, "data": {"account_invites": [], "errored_emails": []}, "error": None}

        service._make_request = fake_make_request
        return captured

    async def test_invite_body_carries_seat_type_role_and_flow_ids(self):
        service = ChatGPTService()
        captured = self._capture(service)

        await service.send_invite("token", "acc-1", "a@b.com", None, seat_type="prolite")

        self.assertEqual(captured["method"], "POST")
        self.assertTrue(captured["url"].endswith("/accounts/acc-1/invites"))
        body = captured["json"]
        self.assertEqual(body["seat_type"], "prolite")
        self.assertEqual(body["email_addresses"], ["a@b.com"])
        self.assertEqual(body["role"], "standard-user")
        self.assertTrue(body["resend_emails"])
        self.assertTrue(body["flow_id"])
        self.assertTrue(body["submission_id"])

    async def test_invite_defaults_to_standard_seat(self):
        service = ChatGPTService()
        captured = self._capture(service)

        await service.send_invite("token", "acc-1", "a@b.com", None)

        self.assertEqual(captured["json"]["seat_type"], "default")

    async def test_invite_rejects_unknown_seat_type(self):
        service = ChatGPTService()
        self._capture(service)

        result = await service.send_invite("token", "acc-1", "a@b.com", None, seat_type="vip")

        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "invalid_seat_type")

    async def test_submission_id_can_be_pinned_for_idempotent_retries(self):
        service = ChatGPTService()
        captured = self._capture(service)

        await service.send_invite(
            "token", "acc-1", "a@b.com", None, submission_id="fixed-submission-id"
        )

        self.assertEqual(captured["json"]["submission_id"], "fixed-submission-id")

    def test_normalize_seat_type(self):
        self.assertEqual(ChatGPTService.normalize_seat_type(" Default "), "default")
        self.assertEqual(ChatGPTService.normalize_seat_type("PROLITE"), "prolite")
        self.assertIsNone(ChatGPTService.normalize_seat_type("premium"))
        self.assertIsNone(ChatGPTService.normalize_seat_type(None))


class SeatTypeAvailabilityTests(unittest.TestCase):
    """席位池先买后用：缺席位时要在本地拦掉，不要浪费一次 API 调用。"""

    def setUp(self):
        self.service = TeamService()

    @staticmethod
    def _team(**kwargs):
        team = Team(email="owner@example.com", access_token_encrypted="x")
        for key, value in kwargs.items():
            setattr(team, key, value)
        return team

    def test_skips_check_when_seats_never_synced(self):
        team = self._team()

        self.assertIsNone(self.service._check_seat_type_availability(team, "default"))

    def test_flags_seat_type_never_purchased(self):
        from app.utils.time_utils import get_now

        team = self._team(
            seats_synced_at=get_now(),
            seats_prolite_total=0,
            seats_prolite_available=0,
        )

        check = self.service._check_seat_type_availability(team, "prolite")

        self.assertIsNotNone(check)
        self.assertEqual(check["error_code"], "seat_type_unavailable")

    def test_flags_exhausted_seat_type(self):
        from app.utils.time_utils import get_now

        team = self._team(
            seats_synced_at=get_now(),
            seats_default_total=2,
            seats_default_available=0,
        )

        check = self.service._check_seat_type_availability(team, "default")

        self.assertIsNotNone(check)
        self.assertEqual(check["error_code"], "seat_type_full")

    def test_passes_when_seat_available(self):
        from app.utils.time_utils import get_now

        team = self._team(
            seats_synced_at=get_now(),
            seats_default_total=2,
            seats_default_available=1,
            seats_prolite_total=1,
            seats_prolite_available=1,
        )

        self.assertIsNone(self.service._check_seat_type_availability(team, "default"))
        self.assertIsNone(self.service._check_seat_type_availability(team, "prolite"))


class SeatPurchasePromptTests(unittest.IsolatedAsyncioTestCase):
    """"additional seat needed" 是加购提示，不该把整个 Team 标成 full。"""

    async def test_additional_seat_needed_keeps_team_active(self):
        service = TeamService()
        team = Team(
            email="owner@example.com",
            access_token_encrypted="x",
            current_members=1,
            max_members=2,
            status="active",
        )
        db_session = AsyncMock()

        handled = await service._handle_api_error(
            {
                "success": False,
                "error": "1 additional seat needed. Add 1 additional seat to send this invite.",
            },
            team,
            db_session,
        )

        self.assertTrue(handled)
        self.assertEqual(team.status, "active")
        db_session.commit.assert_not_awaited()


class FallbackMaxMembersTests(unittest.IsolatedAsyncioTestCase):
    """兜底席位读取：这条路径只在导入/同步读不到真实席位时才走。

    历史上这里踩过一次坑——``settings_service`` 在 team.py 里原本只在个别函数内
    局部导入，抽成独立方法后就成了未定义名字，导致"导入 Team"直接报
    ``name 'settings_service' is not defined``。这里锁定住。
    """

    def setUp(self):
        self.service = TeamService()

    async def test_returns_configured_value(self):
        with patch(
            "app.services.team.settings_service.get_setting",
            new=AsyncMock(return_value="8"),
        ):
            self.assertEqual(await self.service._get_fallback_max_members(None), 8)

    async def test_falls_back_to_default_on_invalid_value(self):
        with patch(
            "app.services.team.settings_service.get_setting",
            new=AsyncMock(return_value="not-a-number"),
        ):
            self.assertEqual(
                await self.service._get_fallback_max_members(None),
                TeamService.DEFAULT_TEAM_MAX_MEMBERS,
            )

    async def test_falls_back_to_default_when_out_of_range(self):
        with patch(
            "app.services.team.settings_service.get_setting",
            new=AsyncMock(return_value="9999"),
        ):
            self.assertEqual(
                await self.service._get_fallback_max_members(None),
                TeamService.DEFAULT_TEAM_MAX_MEMBERS,
            )


if __name__ == "__main__":
    unittest.main()
