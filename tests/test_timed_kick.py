"""定时踢人（按子号配置可用时长）测试。

覆盖：
- 批量配置时长 / 取消定时 / 车主与非法邮箱的拒绝
- 到期扫描的宽限期判定与开关
- 只有到期（含宽限）才真正踢出，且不销毁兑换码
"""

import asyncio
import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.models import RedemptionCode, RedemptionRecord, Team, TeamEmailMapping
from app.services.settings import settings_service
from app.services.team import TeamService
from app.services.warranty import WarrantyService
from app.utils.time_utils import get_now

OWNER_EMAIL = "owner@example.com"
MEMBER_EMAIL = "member@example.com"
PENDING_EMAIL = "pending@example.com"


class _TimedKickBase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        settings_service.clear_cache()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session_factory = async_sessionmaker(
            self.engine, class_=AsyncSession, expire_on_commit=False
        )

        async with self.session_factory() as session:
            session.add(Team(
                id=301,
                email=OWNER_EMAIL,
                access_token_encrypted="token",
                account_id="acct-timed",
                team_name="TimedKickTeam",
                current_members=2,
                max_members=5,
                status="active",
                pool_type="normal",
            ))
            session.add_all([
                TeamEmailMapping(team_id=301, email=OWNER_EMAIL, status="joined", source="sync"),
                TeamEmailMapping(team_id=301, email=MEMBER_EMAIL, status="joined", source="sync"),
                TeamEmailMapping(team_id=301, email=PENDING_EMAIL, status="invited", source="redeem"),
            ])
            await session.commit()

        self.team_service = TeamService()
        self.warranty = WarrantyService()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def _get_mapping(self, email):
        async with self.session_factory() as session:
            result = await session.execute(
                select(TeamEmailMapping).where(
                    TeamEmailMapping.team_id == 301,
                    TeamEmailMapping.email == email,
                )
            )
            return result.scalar_one_or_none()

    async def _add_team(self, team_id, status="active"):
        async with self.session_factory() as session:
            session.add(Team(
                id=team_id,
                email=f"owner{team_id}@example.com",
                access_token_encrypted="token",
                account_id=f"acct-{team_id}",
                team_name=f"Team{team_id}",
                current_members=2,
                max_members=5,
                status=status,
                pool_type="normal",
            ))
            await session.commit()

    async def _set_team_status(self, team_id, status):
        async with self.session_factory() as session:
            team = await session.get(Team, team_id)
            team.status = status
            await session.commit()

    async def _seed_due(self, team_id, count):
        async with self.session_factory() as session:
            for index in range(count):
                session.add(TeamEmailMapping(
                    team_id=team_id,
                    email=f"t{team_id}due{index}@example.com",
                    status="joined",
                    source="sync",
                    kick_at=get_now() - timedelta(hours=1),
                    kick_hours=2,
                ))
            await session.commit()

    @staticmethod
    def _record_sleeps():
        delays = []
        real_sleep = asyncio.sleep

        async def fake_sleep(seconds):
            delays.append(seconds)
            await real_sleep(0)

        return delays, fake_sleep

    async def _run_with_settings(self, extra_settings):
        self.warranty.team_service = self.team_service
        async with self.session_factory() as session:
            await settings_service.update_settings(session, {
                "timed_kick_enabled": "true",
                "timed_kick_grace_minutes": "5",
                **extra_settings,
            })

        delays, fake_sleep = self._record_sleeps()
        with patch.object(
            self.team_service,
            "remove_invite_or_member",
            new=AsyncMock(return_value={"success": True, "message": "ok"}),
        ), patch("app.services.warranty.asyncio.sleep", new=fake_sleep):
            async with self.session_factory() as session:
                stats = await self.warranty.run_timed_member_auto_kick(session)
        return stats, delays


class ParseKickAtTests(unittest.TestCase):
    """前端传的是北京时间字符串，后端按 settings.timezone 解释。"""

    def test_parses_datetime_local_value(self):
        self.assertEqual(
            TeamService.parse_kick_at("2026-09-17T22:38"),
            datetime(2026, 9, 17, 22, 38),
        )

    def test_parses_space_separated_with_seconds(self):
        self.assertEqual(
            TeamService.parse_kick_at("2026-09-17 22:38:05"),
            datetime(2026, 9, 17, 22, 38, 5),
        )

    def test_parses_date_only(self):
        self.assertEqual(
            TeamService.parse_kick_at("2026-09-17"),
            datetime(2026, 9, 17, 0, 0),
        )

    def test_blank_means_cancel(self):
        self.assertIsNone(TeamService.parse_kick_at(None))
        self.assertIsNone(TeamService.parse_kick_at(""))
        self.assertIsNone(TeamService.parse_kick_at("   "))

    def test_invalid_value_raises(self):
        with self.assertRaises(ValueError):
            TeamService.parse_kick_at("tomorrow-ish")


class SetMemberKickTimeTests(_TimedKickBase):
    async def test_sets_exact_kick_time(self):
        target = (get_now() + timedelta(hours=6)).replace(second=0, microsecond=0)

        async with self.session_factory() as session:
            result = await self.team_service.set_member_kick_time(
                301, [MEMBER_EMAIL], None, session, kick_at=target
            )

        self.assertTrue(result["success"])
        mapping = await self._get_mapping(MEMBER_EMAIL)
        self.assertEqual(mapping.kick_at, target)
        self.assertEqual(mapping.kick_hours, 6)
        # 返回给前端的必须带时区偏移
        self.assertRegex(result["kick_at"], r"[+-]\d{2}:\d{2}$")

    async def test_past_kick_time_is_rejected(self):
        async with self.session_factory() as session:
            result = await self.team_service.set_member_kick_time(
                301, [MEMBER_EMAIL], None, session,
                kick_at=get_now() - timedelta(minutes=1),
            )

        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "invalid_kick_at")
        mapping = await self._get_mapping(MEMBER_EMAIL)
        self.assertIsNone(mapping.kick_at)

    async def test_kick_at_takes_priority_over_hours(self):
        target = (get_now() + timedelta(hours=9)).replace(second=0, microsecond=0)

        async with self.session_factory() as session:
            result = await self.team_service.set_member_kick_time(
                301, [MEMBER_EMAIL], 2, session, kick_at=target
            )

        self.assertTrue(result["success"])
        mapping = await self._get_mapping(MEMBER_EMAIL)
        self.assertEqual(mapping.kick_at, target)
        self.assertEqual(mapping.kick_hours, 9)

    async def test_sets_kick_deadline_from_configuration_moment(self):
        async with self.session_factory() as session:
            before = get_now()
            result = await self.team_service.set_member_kick_time(
                301, [MEMBER_EMAIL, PENDING_EMAIL], 4, session
            )
            after = get_now()

        self.assertTrue(result["success"])
        self.assertEqual(result["updated"], 2)

        mapping = await self._get_mapping(MEMBER_EMAIL)
        self.assertEqual(mapping.kick_hours, 4)
        self.assertGreaterEqual(mapping.kick_at, before + timedelta(hours=4))
        self.assertLessEqual(mapping.kick_at, after + timedelta(hours=4))

    async def test_zero_hours_cancels_timer(self):
        async with self.session_factory() as session:
            await self.team_service.set_member_kick_time(301, [MEMBER_EMAIL], 4, session)

        async with self.session_factory() as session:
            result = await self.team_service.set_member_kick_time(301, [MEMBER_EMAIL], 0, session)

        self.assertTrue(result["success"])
        mapping = await self._get_mapping(MEMBER_EMAIL)
        self.assertIsNone(mapping.kick_at)
        self.assertIsNone(mapping.kick_hours)

    async def test_owner_cannot_be_configured(self):
        async with self.session_factory() as session:
            result = await self.team_service.set_member_kick_time(
                301, [OWNER_EMAIL], 4, session
            )

        self.assertFalse(result["success"])
        self.assertIn("车主", result["results"][0]["error"])
        mapping = await self._get_mapping(OWNER_EMAIL)
        self.assertIsNone(mapping.kick_at)

    async def test_unknown_member_is_rejected(self):
        async with self.session_factory() as session:
            result = await self.team_service.set_member_kick_time(
                301, ["ghost@example.com"], 4, session
            )

        self.assertFalse(result["success"])
        self.assertIn("不在 Team 中", result["results"][0]["error"])

    async def test_out_of_range_hours_is_rejected(self):
        async with self.session_factory() as session:
            result = await self.team_service.set_member_kick_time(
                301, [MEMBER_EMAIL], TeamService.MAX_KICK_HOURS + 1, session
            )

        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "invalid_kick_hours")

    async def test_removing_mapping_clears_timer(self):
        async with self.session_factory() as session:
            await self.team_service.set_member_kick_time(301, [MEMBER_EMAIL], 4, session)

        async with self.session_factory() as session:
            await self.team_service.mark_team_email_mapping_removed(
                301, MEMBER_EMAIL, session, source="api"
            )
            await session.commit()

        mapping = await self._get_mapping(MEMBER_EMAIL)
        self.assertEqual(mapping.status, "removed")
        self.assertIsNone(mapping.kick_at)
        self.assertIsNone(mapping.kick_hours)


class TimedKickScanTests(_TimedKickBase):
    async def _set_raw_kick_at(self, email, kick_at, kick_hours=4):
        async with self.session_factory() as session:
            result = await session.execute(
                select(TeamEmailMapping).where(
                    TeamEmailMapping.team_id == 301,
                    TeamEmailMapping.email == email,
                )
            )
            mapping = result.scalar_one()
            mapping.kick_at = kick_at
            mapping.kick_hours = kick_hours
            await session.commit()

    async def test_disabled_switch_yields_no_candidates(self):
        await self._set_raw_kick_at(MEMBER_EMAIL, get_now() - timedelta(hours=1))

        async with self.session_factory() as session:
            await settings_service.update_settings(session, {"timed_kick_enabled": "false"})
            scan = await self.warranty.scan_due_timed_members(session)

        self.assertTrue(scan["success"])
        self.assertFalse(scan["enabled"])
        self.assertEqual(scan["total"], 0)

    async def test_due_member_is_scanned_after_grace(self):
        await self._set_raw_kick_at(MEMBER_EMAIL, get_now() - timedelta(minutes=10))

        async with self.session_factory() as session:
            await settings_service.update_settings(session, {
                "timed_kick_enabled": "true",
                "timed_kick_grace_minutes": "5",
            })
            scan = await self.warranty.scan_due_timed_members(session)

        self.assertTrue(scan["enabled"])
        self.assertEqual(scan["grace_minutes"], 5)
        self.assertEqual([c["email"] for c in scan["candidates"]], [MEMBER_EMAIL])

    async def test_member_inside_grace_is_not_scanned(self):
        await self._set_raw_kick_at(MEMBER_EMAIL, get_now() - timedelta(minutes=2))

        async with self.session_factory() as session:
            await settings_service.update_settings(session, {
                "timed_kick_enabled": "true",
                "timed_kick_grace_minutes": "5",
            })
            scan = await self.warranty.scan_due_timed_members(session)

        self.assertEqual(scan["total"], 0)

    async def test_zero_grace_kicks_immediately_after_deadline(self):
        await self._set_raw_kick_at(MEMBER_EMAIL, get_now() - timedelta(seconds=1))

        async with self.session_factory() as session:
            await settings_service.update_settings(session, {
                "timed_kick_enabled": "true",
                "timed_kick_grace_minutes": "0",
            })
            scan = await self.warranty.scan_due_timed_members(session)

        self.assertEqual([c["email"] for c in scan["candidates"]], [MEMBER_EMAIL])

    async def test_owner_is_never_a_candidate(self):
        await self._set_raw_kick_at(OWNER_EMAIL, get_now() - timedelta(hours=1))

        async with self.session_factory() as session:
            await settings_service.update_settings(session, {
                "timed_kick_enabled": "true",
                "timed_kick_grace_minutes": "5",
            })
            scan = await self.warranty.scan_due_timed_members(session)

        self.assertEqual(scan["total"], 0)


class TimedKickExecutionTests(_TimedKickBase):
    async def _prepare(self, kick_at):
        async with self.session_factory() as session:
            result = await session.execute(
                select(TeamEmailMapping).where(
                    TeamEmailMapping.team_id == 301,
                    TeamEmailMapping.email == MEMBER_EMAIL,
                )
            )
            mapping = result.scalar_one()
            mapping.kick_at = kick_at
            mapping.kick_hours = 4
            # 关联一个兑换码与兑换记录，用来验证"只踢人、不销毁码"
            session.add(RedemptionCode(
                code="TIMED-CODE-001",
                has_warranty=False,
                status="used",
                used_by_email=MEMBER_EMAIL,
                used_team_id=301,
                used_at=get_now(),
                pool_type="normal",
            ))
            session.add(RedemptionRecord(
                email=MEMBER_EMAIL,
                code="TIMED-CODE-001",
                team_id=301,
                account_id="acct-timed",
            ))
            await session.commit()

    async def test_due_member_is_kicked_and_code_is_preserved(self):
        await self._prepare(get_now() - timedelta(minutes=30))

        async with self.session_factory() as session:
            await settings_service.update_settings(session, {
                "timed_kick_enabled": "true",
                "timed_kick_grace_minutes": "5",
            })

        self.warranty.team_service = self.team_service
        with patch.object(
            self.team_service,
            "remove_invite_or_member",
            new=AsyncMock(return_value={"success": True, "message": "成员已删除"}),
        ):
            async with self.session_factory() as session:
                stats = await self.warranty.run_timed_member_auto_kick(session)

        self.assertTrue(stats["success"])
        self.assertEqual(stats["kicked"], 1)
        self.assertEqual(stats["failed"], 0)

        mapping = await self._get_mapping(MEMBER_EMAIL)
        self.assertEqual(mapping.status, "removed")
        self.assertEqual(mapping.source, "auto_kick_timed")
        self.assertIsNone(mapping.kick_at)

        # 兑换码与兑换记录必须保留
        async with self.session_factory() as session:
            code = (await session.execute(
                select(RedemptionCode).where(RedemptionCode.code == "TIMED-CODE-001")
            )).scalar_one_or_none()
            record_count = len((await session.execute(
                select(RedemptionRecord).where(RedemptionRecord.code == "TIMED-CODE-001")
            )).scalars().all())
        self.assertIsNotNone(code)
        self.assertEqual(record_count, 1)

    async def test_member_still_in_grace_is_skipped(self):
        await self._prepare(get_now() - timedelta(minutes=1))

        self.warranty.team_service = self.team_service
        remove_mock = AsyncMock(return_value={"success": True, "message": "成员已删除"})
        with patch.object(
            self.team_service, "remove_invite_or_member", new=remove_mock
        ):
            async with self.session_factory() as session:
                await settings_service.update_settings(session, {
                    "timed_kick_enabled": "true",
                    "timed_kick_grace_minutes": "5",
                })
                stats = await self.warranty.run_timed_member_auto_kick(session)

        self.assertEqual(stats["kicked"], 0)
        remove_mock.assert_not_awaited()
        mapping = await self._get_mapping(MEMBER_EMAIL)
        self.assertEqual(mapping.status, "joined")

    async def test_kick_timed_member_skips_when_timer_cleared(self):
        await self._prepare(get_now() - timedelta(hours=2))
        async with self.session_factory() as session:
            result = await session.execute(
                select(TeamEmailMapping).where(
                    TeamEmailMapping.team_id == 301,
                    TeamEmailMapping.email == MEMBER_EMAIL,
                )
            )
            result.scalar_one().kick_at = None
            await session.commit()

        self.warranty.team_service = self.team_service
        with patch.object(
            self.team_service,
            "remove_invite_or_member",
            new=AsyncMock(return_value={"success": True}),
        ):
            async with self.session_factory() as session:
                item = await self.warranty.kick_timed_member(session, 301, MEMBER_EMAIL)

        self.assertEqual(item["category"], "skipped")
        self.assertEqual(item["skip_reason"], "kick_time_cleared")


class BatchKickIntervalTests(_TimedKickBase):
    """批量踢出时，同一 Team 内每两个账号之间要按配置区间随机等待，避免被风控。"""

    async def test_waits_random_interval_between_accounts(self):
        await self._seed_due(301, 3)

        stats, delays = await self._run_with_settings({
            "kick_interval_min_seconds": "10",
            "kick_interval_max_seconds": "20",
        })

        self.assertEqual(stats["kicked"], 3)
        # 3 个账号之间只等待 2 次（首尾不等待）
        self.assertEqual(len(delays), 2)
        for delay in delays:
            self.assertGreaterEqual(delay, 10)
            self.assertLessEqual(delay, 20)

    async def test_zero_interval_disables_waiting(self):
        await self._seed_due(301, 3)

        stats, delays = await self._run_with_settings({
            "kick_interval_min_seconds": "0",
            "kick_interval_max_seconds": "0",
        })

        self.assertEqual(stats["kicked"], 3)
        self.assertEqual(delays, [])

    async def test_interval_range_swaps_reversed_bounds(self):
        async with self.session_factory() as session:
            await settings_service.update_settings(session, {
                "kick_interval_min_seconds": "30",
                "kick_interval_max_seconds": "5",
            })
            min_seconds, max_seconds = await self.warranty.get_kick_interval_range(session)

        self.assertEqual((min_seconds, max_seconds), (5.0, 30.0))

    async def test_interval_range_defaults_to_15_20(self):
        """未显式配置批量踢出间隔时的产品默认值。

        这个默认值同时落在四处，改动必须一起动，否则设置页显示与实际行为不一致：
        app/services/warranty.py 的 DEFAULT_KICK_INTERVAL_*、
        app/routes/admin.py 读取设置时的兜底字符串、
        app/templates/admin/settings/index.html 的输入框初值与帮助文案、
        init_db.py 写入的默认设置。
        """
        async with self.session_factory() as session:
            min_seconds, max_seconds = await self.warranty.get_kick_interval_range(session)

        self.assertEqual((min_seconds, max_seconds), (15.0, 20.0))


class TeamUnavailableKickTests(_TimedKickBase):
    """Team 登录失效时，候选必须被短路跳过。

    这是线上踩过的坑：26 个到期子号挂在一个 token 已失效的 Team 上，
    每轮都逐个发请求 + 逐次随机等待，整轮拖到 7 分钟，导致同一时刻真正
    能踢的子号被挤到十几分钟后才轮到。
    """

    async def test_unavailable_team_candidate_is_blocked_without_request(self):
        await self._seed_due(301, 2)
        await self._set_team_status(301, "error")

        async with self.session_factory() as session:
            await settings_service.update_settings(session, {
                "timed_kick_enabled": "true",
                "timed_kick_grace_minutes": "5",
            })

        self.warranty.team_service = self.team_service
        remove_mock = AsyncMock(return_value={"success": True, "message": "ok"})
        delays, fake_sleep = self._record_sleeps()
        with patch.object(
            self.team_service, "remove_invite_or_member", new=remove_mock
        ), patch("app.services.warranty.asyncio.sleep", new=fake_sleep):
            async with self.session_factory() as session:
                stats = await self.warranty.run_timed_member_auto_kick(session)

        self.assertEqual(stats["blocked"], 2)
        self.assertEqual(stats["failed"], 0)
        self.assertEqual(stats["kicked"], 0)
        self.assertTrue(stats["success"])
        remove_mock.assert_not_awaited()
        # 被跳过的候选不占用错峰等待
        self.assertEqual(delays, [])

    async def test_expired_team_is_blocked_too(self):
        await self._seed_due(301, 1)
        await self._set_team_status(301, "expired")

        async with self.session_factory() as session:
            item = await self.warranty.kick_timed_member(session, 301, "t301due0@example.com")

        self.assertEqual(item["category"], "blocked")
        self.assertEqual(item["skip_reason"], "team_expired")

    async def test_blocked_team_does_not_hold_up_healthy_team(self):
        """坏 Team 排在前面时，好 Team 的到期子号必须当轮就踢掉，且不产生等待。"""
        await self._add_team(302, status="active")
        await self._seed_due(301, 2)
        await self._seed_due(302, 1)
        await self._set_team_status(301, "error")

        stats, delays = await self._run_with_settings({})

        self.assertEqual(stats["blocked"], 2)
        self.assertEqual(stats["kicked"], 1)
        self.assertEqual(delays, [])

    async def test_waiting_only_happens_inside_same_team(self):
        """跨 Team 的两次请求不需要错峰，只有同一工作区连续变更才需要。"""
        await self._add_team(302, status="active")
        await self._seed_due(301, 2)
        await self._seed_due(302, 2)

        stats, delays = await self._run_with_settings({
            "kick_interval_min_seconds": "10",
            "kick_interval_max_seconds": "20",
        })

        self.assertEqual(stats["kicked"], 4)
        # 每个 Team 内部各等待 1 次，跨 Team 边界不等待
        self.assertEqual(len(delays), 2)


class KickTimeFormattingTests(unittest.TestCase):
    """kick_at 必须带时区偏移，否则前端 new Date() 会按浏览器时区解析成错误时刻。"""

    def test_naive_local_time_is_serialized_with_offset(self):
        naive = datetime(2026, 9, 17, 22, 14, 41)

        serialized = TeamService._to_aware_isoformat(naive)

        self.assertIsNotNone(serialized)
        self.assertIn("22:14:41", serialized)
        # 带偏移量（形如 +08:00），前端才能还原成正确的绝对时刻
        self.assertRegex(serialized, r"[+-]\d{2}:\d{2}$")

    def test_none_is_passed_through(self):
        self.assertIsNone(TeamService._to_aware_isoformat(None))


if __name__ == "__main__":
    unittest.main()
