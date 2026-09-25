"""限流（429）处理。

官方对同一工作区的并发成员变更会回 429 "Another subscription update is in
progress"，含义是"等一下再来"。这里钉住两件事：

- 撞上限流要按 Retry-After / 固定退避重试，而不是立刻放弃；
- 限流响应不能累加 Team 的 error_count —— 否则连续几次就会把正常 Team 判成
  error，之后它的邀请与踢人会被整体跳过，等于自己把账号打成"异常"。
"""

import unittest
from unittest.mock import AsyncMock, patch

from app.models import Team
from app.services.chatgpt import ChatGPTService
from app.services.team import TeamService


class _FakeResponse:
    def __init__(self, status_code, payload=None, headers=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _FakeSession:
    """按顺序吐响应，并记录被调用了几次。"""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    async def post(self, url, **kwargs):
        self.calls += 1
        return self._responses.pop(0)


class RetryAfterParsingTests(unittest.TestCase):
    def test_reads_seconds_and_caps_absurd_values(self):
        self.assertEqual(
            ChatGPTService._parse_retry_after(_FakeResponse(429, headers={"retry-after": "3"})),
            3.0,
        )
        self.assertEqual(
            ChatGPTService._parse_retry_after(_FakeResponse(429, headers={"retry-after": "600"})),
            60.0,
        )

    def test_ignores_missing_and_unusable_values(self):
        self.assertIsNone(ChatGPTService._parse_retry_after(_FakeResponse(429)))
        self.assertIsNone(
            ChatGPTService._parse_retry_after(
                _FakeResponse(429, headers={"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"})
            )
        )
        self.assertIsNone(
            ChatGPTService._parse_retry_after(_FakeResponse(429, headers={"retry-after": "-1"}))
        )


class RateLimitRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_after_429_then_succeeds(self):
        service = ChatGPTService()
        session = _FakeSession([
            _FakeResponse(429, headers={"retry-after": "2"}, text="Another subscription update is in progress."),
            _FakeResponse(200, payload={"ok": True}),
        ])

        with patch.object(service, "_get_session", new=AsyncMock(return_value=session)), \
             patch("app.services.chatgpt.asyncio.sleep", new=AsyncMock()) as sleep_mock:
            result = await service._make_request("POST", "https://example.test/x", {}, {}, None, "acc_1")

        self.assertTrue(result["success"])
        self.assertEqual(session.calls, 2)
        sleep_mock.assert_awaited()

    async def test_gives_up_after_retries_with_rate_limited_code(self):
        service = ChatGPTService()
        session = _FakeSession([
            _FakeResponse(429, text="too many requests"),
            _FakeResponse(429, text="too many requests"),
            _FakeResponse(429, text="too many requests"),
        ])

        with patch.object(service, "_get_session", new=AsyncMock(return_value=session)), \
             patch("app.services.chatgpt.asyncio.sleep", new=AsyncMock()):
            result = await service._make_request("POST", "https://example.test/x", {}, {}, None, "acc_1")

        self.assertFalse(result["success"])
        self.assertEqual(result["status_code"], 429)
        self.assertEqual(result["error_code"], "rate_limited")
        self.assertEqual(session.calls, ChatGPTService.MAX_RETRIES)


class RateLimitDoesNotMarkTeamErrorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from app.database import Base

        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self):
        await self.engine.dispose()

    @staticmethod
    def _new_team():
        return Team(
            email="owner@example.com",
            access_token_encrypted="x",
            status="active",
            error_count=0,
        )

    async def test_rate_limited_response_is_not_counted_as_error(self):
        # Team 与断言必须在同一个 session 里，否则 ORM 实例不属于该 session
        async with self.session_factory() as session:
            team = self._new_team()
            session.add(team)
            await session.commit()

            handled = await TeamService()._handle_api_error(
                {
                    "success": False,
                    "status_code": 429,
                    "error": "another subscription update is in progress. please try again.",
                },
                team,
                session,
            )
            await session.refresh(team)

            self.assertFalse(handled)
            self.assertEqual(team.error_count, 0)
            self.assertEqual(team.status, "active")

    async def test_other_errors_still_accumulate(self):
        async with self.session_factory() as session:
            team = self._new_team()
            session.add(team)
            await session.commit()

            await TeamService()._handle_api_error(
                {"success": False, "status_code": 500, "error": "server exploded"},
                team,
                session,
            )
            await session.refresh(team)

            self.assertEqual(team.error_count, 1)
            self.assertEqual(team.status, "active")


if __name__ == "__main__":
    unittest.main()
