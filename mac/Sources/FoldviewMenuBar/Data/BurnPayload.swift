import Foundation

/// Codable model for the FROZEN `pm burn --json [--days N]` schemaVersion-1
/// payload. Every section is optional and tolerant: a `pm` build that cannot
/// price one provider (or has no GitHub credentials) still returns a payload
/// this build can decode, and unknown keys are ignored throughout.
struct BurnPayload: Decodable, Sendable, Equatable {
    let schemaVersion: Int
    let ok: Bool?
    let generatedAt: String?
    let days: Int?
    let claude: ClaudeBurn?
    let kimi: KimiBurn?
    let codex: CodexBurn?
    let codingTime: CodingTime?
    let github: GitHubSection?

    init(
        schemaVersion: Int,
        ok: Bool? = nil,
        generatedAt: String? = nil,
        days: Int? = nil,
        claude: ClaudeBurn? = nil,
        kimi: KimiBurn? = nil,
        codex: CodexBurn? = nil,
        codingTime: CodingTime? = nil,
        github: GitHubSection? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.ok = ok
        self.generatedAt = generatedAt
        self.days = days
        self.claude = claude
        self.kimi = kimi
        self.codex = codex
        self.codingTime = codingTime
        self.github = github
    }
}

/// Token totals for one day of activity, e.g. `claude.tokens.byDay[]`.
struct BurnDayTokens: Decodable, Sendable, Equatable, Identifiable {
    let date: String
    let input: Int?
    let output: Int?
    let cacheRead: Int?
    let cacheWrite: Int?

    var id: String { date }

    /// Total tokens for chart display; nil components count as zero.
    var total: Int {
        (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
    }
}

/// Rolling today/week/month token totals plus the per-day series.
struct BurnTokenTotals: Decodable, Sendable, Equatable {
    let today: Int?
    let week: Int?
    let month: Int?
    let byDay: [BurnDayTokens]?

    init(today: Int? = nil, week: Int? = nil, month: Int? = nil, byDay: [BurnDayTokens]? = nil) {
        self.today = today
        self.week = week
        self.month = month
        self.byDay = byDay
    }
}

/// Per-model token and cost breakdown (`claude.byModel.<model>`).
struct BurnModelTokens: Decodable, Sendable, Equatable {
    let input: Int?
    let output: Int?
    let cacheRead: Int?
    let cacheWrite: Int?
    let costUsd: Double?
}

/// Rolling USD cost totals.
struct BurnCostTotals: Decodable, Sendable, Equatable {
    let today: Double?
    let week: Double?
    let month: Double?

    init(today: Double? = nil, week: Double? = nil, month: Double? = nil) {
        self.today = today
        self.week = week
        self.month = month
    }
}

/// The `claude` section: priced tokens with model and cache detail.
struct ClaudeBurn: Decodable, Sendable, Equatable {
    let tokens: BurnTokenTotals?
    let byModel: [String: BurnModelTokens]?
    let costUsd: BurnCostTotals?
    let cacheHitPct: Double?
    let unpricedModels: [String]?

    init(
        tokens: BurnTokenTotals? = nil,
        byModel: [String: BurnModelTokens]? = nil,
        costUsd: BurnCostTotals? = nil,
        cacheHitPct: Double? = nil,
        unpricedModels: [String]? = nil
    ) {
        self.tokens = tokens
        self.byModel = byModel
        self.costUsd = costUsd
        self.cacheHitPct = cacheHitPct
        self.unpricedModels = unpricedModels
    }
}

/// The `kimi` section: token totals without pricing, plus an optional note
/// from the CLI explaining the accounting basis.
struct KimiBurn: Decodable, Sendable, Equatable {
    let tokens: BurnTokenTotals?
    let note: String?

    init(tokens: BurnTokenTotals? = nil, note: String? = nil) {
        self.tokens = tokens
        self.note = note
    }
}

/// The `codex` section: cumulative token totals plus quota state.
struct CodexBurn: Decodable, Sendable, Equatable {
    let tokens: CodexTokens?
    let quota: CodexQuota?

    init(tokens: CodexTokens? = nil, quota: CodexQuota? = nil) {
        self.tokens = tokens
        self.quota = quota
    }

    struct CodexTokens: Decodable, Sendable, Equatable {
        let total: Total?

        init(total: Total? = nil) {
            self.total = total
        }

        struct Total: Decodable, Sendable, Equatable {
            let input: Int?
            let output: Int?
            let cached: Int?
            let total: Int?

            init(input: Int? = nil, output: Int? = nil, cached: Int? = nil, total: Int? = nil) {
                self.input = input
                self.output = output
                self.cached = cached
                self.total = total
            }
        }
    }

    struct CodexQuota: Decodable, Sendable, Equatable {
        let usedPercent: Double?
        let windowMinutes: Int?
        let resetsAt: String?
        let creditBalance: Double?
        let planType: String?

        init(
            usedPercent: Double? = nil,
            windowMinutes: Int? = nil,
            resetsAt: String? = nil,
            creditBalance: Double? = nil,
            planType: String? = nil
        ) {
            self.usedPercent = usedPercent
            self.windowMinutes = windowMinutes
            self.resetsAt = resetsAt
            self.creditBalance = creditBalance
            self.planType = planType
        }
    }
}

/// The `codingTime` section: minutes spent coding, per day and rolled up.
struct CodingTime: Decodable, Sendable, Equatable {
    let todayMin: Int?
    let weekMin: Int?
    let monthMin: Int?
    let totalMin: Int?
    let byDay: [Day]?

    init(
        todayMin: Int? = nil,
        weekMin: Int? = nil,
        monthMin: Int? = nil,
        totalMin: Int? = nil,
        byDay: [Day]? = nil
    ) {
        self.todayMin = todayMin
        self.weekMin = weekMin
        self.monthMin = monthMin
        self.totalMin = totalMin
        self.byDay = byDay
    }

    struct Day: Decodable, Sendable, Equatable, Identifiable {
        let date: String
        let minutes: Int?

        var id: String { date }
    }
}

/// The `github` section: either contribution data or an embedded error when
/// `pm` could not reach GitHub. Both shapes decode into this one struct so a
/// section failure never invalidates the rest of the payload.
struct GitHubSection: Decodable, Sendable, Equatable {
    let login: String?
    let commits30d: Int?
    let byRepo: [RepoCommits]?
    let error: SectionError?

    var isError: Bool { error != nil }

    init(
        login: String? = nil,
        commits30d: Int? = nil,
        byRepo: [RepoCommits]? = nil,
        error: SectionError? = nil
    ) {
        self.login = login
        self.commits30d = commits30d
        self.byRepo = byRepo
        self.error = error
    }

    struct RepoCommits: Decodable, Sendable, Equatable, Identifiable {
        let repo: String
        let commits: Int?

        var id: String { repo }
    }

    struct SectionError: Decodable, Sendable, Equatable {
        let code: String?
        let message: String?

        init(code: String? = nil, message: String? = nil) {
            self.code = code
            self.message = message
        }

        private enum CodingKeys: String, CodingKey {
            case code, message
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            // `code` may arrive as a string or a number depending on the failure.
            if let string = try? container.decode(String.self, forKey: .code) {
                code = string
            } else if let number = try? container.decode(Int.self, forKey: .code) {
                code = String(number)
            } else {
                code = nil
            }
            message = try container.decodeIfPresent(String.self, forKey: .message)
        }
    }
}
