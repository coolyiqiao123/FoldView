import Foundation
import Testing
@testable import FoldviewMenuBar

/// Decoding tests for the frozen `pm burn --json --days N` schemaVersion-1
/// payload: a full valid fixture (including the GitHub error union shape),
/// forward-compatible unknown keys, and missing sections.
struct BurnPayloadTests {
    static let validJSON = """
    {
      "schemaVersion": 1,
      "ok": true,
      "generatedAt": "2026-07-20T12:00:00.000Z",
      "days": 30,
      "claude": {
        "tokens": {
          "today": 1234567,
          "week": 8901234,
          "month": 34567890,
          "byDay": [
            {"date": "2026-07-19", "input": 1000, "output": 2000, "cacheRead": 3000, "cacheWrite": 4000},
            {"date": "2026-07-20", "input": 5000, "output": 6000, "cacheRead": 7000, "cacheWrite": 8000}
          ]
        },
        "byModel": {
          "claude-opus-4": {"input": 100, "output": 200, "cacheRead": 300, "cacheWrite": 400, "costUsd": 1.23}
        },
        "costUsd": {"today": 4.56, "week": 30.12, "month": 120.45},
        "cacheHitPct": 87.5,
        "unpricedModels": ["future-model-1"]
      },
      "kimi": {
        "tokens": {"today": 111, "week": 222, "month": 333, "byDay": []},
        "note": "tokens counted from local session logs"
      },
      "codex": {
        "tokens": {"total": {"input": 10, "output": 20, "cached": 30, "total": 60}},
        "quota": {"usedPercent": 42.5, "windowMinutes": 300, "resetsAt": "2026-07-20T15:00:00.000Z", "creditBalance": 25.0, "planType": "pro"}
      },
      "codingTime": {
        "todayMin": 95,
        "weekMin": 610,
        "monthMin": 2400,
        "totalMin": 9876,
        "byDay": [{"date": "2026-07-20", "minutes": 95}]
      },
      "github": {
        "login": "octocat",
        "commits30d": 17,
        "byRepo": [
          {"repo": "foldview", "commits": 12},
          {"repo": "other", "commits": 5}
        ]
      }
    }
    """

    static let githubErrorJSON = """
    {
      "schemaVersion": 1,
      "ok": true,
      "generatedAt": "2026-07-20T12:00:00.000Z",
      "days": 30,
      "github": {"error": {"code": "auth-missing", "message": "gh CLI not authenticated"}}
    }
    """

    static let numericErrorCodeJSON = """
    {
      "schemaVersion": 1,
      "github": {"error": {"code": 429, "message": "rate limited"}}
    }
    """

    static let forwardCompatibleJSON = """
    {
      "schemaVersion": 1,
      "ok": true,
      "futureSection": {"nested": [1, 2, 3]},
      "claude": {
        "tokens": {"today": 5, "byDay": [{"date": "2026-07-20", "input": 1, "unknownField": true}]},
        "costUsd": {"today": 0.01, "year": 100.0},
        "futureClaudeField": "x"
      }
    }
    """

    @Test func decodesValidPayload() throws {
        let payload = try JSONDecoder().decode(BurnPayload.self, from: Data(Self.validJSON.utf8))
        #expect(payload.schemaVersion == 1)
        #expect(payload.ok == true)
        #expect(payload.days == 30)

        let claude = try #require(payload.claude)
        #expect(claude.tokens?.today == 1234567)
        #expect(claude.tokens?.week == 8901234)
        #expect(claude.tokens?.month == 34567890)
        #expect(claude.tokens?.byDay?.count == 2)
        #expect(claude.tokens?.byDay?[0].date == "2026-07-19")
        #expect(claude.tokens?.byDay?[0].total == 10000)
        #expect(claude.byModel?["claude-opus-4"]?.costUsd == 1.23)
        #expect(claude.costUsd?.today == 4.56)
        #expect(claude.costUsd?.week == 30.12)
        #expect(claude.costUsd?.month == 120.45)
        #expect(claude.cacheHitPct == 87.5)
        #expect(claude.unpricedModels == ["future-model-1"])

        let kimi = try #require(payload.kimi)
        #expect(kimi.tokens?.today == 111)
        #expect(kimi.note == "tokens counted from local session logs")

        let codex = try #require(payload.codex)
        #expect(codex.tokens?.total?.total == 60)
        #expect(codex.tokens?.total?.cached == 30)
        #expect(codex.quota?.usedPercent == 42.5)
        #expect(codex.quota?.planType == "pro")
        #expect(codex.quota?.creditBalance == 25.0)

        let codingTime = try #require(payload.codingTime)
        #expect(codingTime.todayMin == 95)
        #expect(codingTime.totalMin == 9876)
        #expect(codingTime.byDay?.first?.minutes == 95)

        let github = try #require(payload.github)
        #expect(!github.isError)
        #expect(github.login == "octocat")
        #expect(github.commits30d == 17)
        #expect(github.byRepo?.count == 2)
        #expect(github.byRepo?.first?.repo == "foldview")
    }

    @Test func decodesGitHubErrorUnion() throws {
        let payload = try JSONDecoder().decode(BurnPayload.self, from: Data(Self.githubErrorJSON.utf8))
        let github = try #require(payload.github)
        #expect(github.isError)
        #expect(github.error?.code == "auth-missing")
        #expect(github.error?.message == "gh CLI not authenticated")
        #expect(github.commits30d == nil)
        // Sections absent from the fixture decode as nil, not as failures.
        #expect(payload.claude == nil)
        #expect(payload.kimi == nil)
        #expect(payload.codex == nil)
        #expect(payload.codingTime == nil)
    }

    @Test func toleratesNumericGitHubErrorCode() throws {
        let payload = try JSONDecoder().decode(BurnPayload.self, from: Data(Self.numericErrorCodeJSON.utf8))
        #expect(payload.github?.error?.code == "429")
    }

    @Test func ignoresUnknownKeysAtEveryLevel() throws {
        let payload = try JSONDecoder().decode(BurnPayload.self, from: Data(Self.forwardCompatibleJSON.utf8))
        #expect(payload.claude?.tokens?.today == 5)
        #expect(payload.claude?.costUsd?.today == 0.01)
        #expect(payload.claude?.tokens?.byDay?.first?.input == 1)
        #expect(payload.kimi == nil)
    }

    @Test func rejectsPayloadWithoutSchemaVersion() {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(BurnPayload.self, from: Data("{\"ok\":true}".utf8))
        }
    }
}
