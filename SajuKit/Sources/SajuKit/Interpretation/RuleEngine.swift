import Foundation

/// 해석 룰 — 번들 JSON에서 로드.
public struct Rule: Sendable, Codable, Hashable, Identifiable {
    public let id: String
    public let category: String
    public let title: String
    public let hanja: String?
    public let tags: [String]
    public let text: String
}

public struct RuleSet: Sendable {
    public let rules: [Rule]
    /// 근거 콘텐츠의 판 번호(rules.json의 `version`).
    ///
    /// 이 값이 오르면 같은 명식에서 나오는 근거 문장이 달라진다. 이미
    /// 생성해 둔 해석에 "이전 판으로 쓰였다"고 표시할 수 있어야 하므로
    /// 로드 시점에 버리지 않고 들고 있는다.
    public let version: Int
    private let byTag: [String: [Rule]]

    public init(rules: [Rule], version: Int = 0) {
        self.rules = rules
        self.version = version
        var index: [String: [Rule]] = [:]
        for rule in rules {
            for tag in rule.tags {
                index[tag, default: []].append(rule)
            }
        }
        self.byTag = index
    }

    /// rules.json 바이트에서 직접 로드.
    ///
    /// `bundled()`와 갈라 둔 이유는 브라우저입니다. wasm에는 파일시스템이 없고,
    /// SwiftPM이 만들어 주는 `Bundle.module`은 **빌드한 기계의 절대 경로**를 그대로
    /// 기억합니다. 게다가 못 찾으면 던지지 않고 그 자리에서 죽습니다(fatalError) —
    /// `do/catch`로 감싸도 소용이 없습니다. 그래서 wasm에서는 규칙 바이트를
    /// 바깥에서 받아 넣습니다. 나가는 것은 규칙 파일뿐이고 생년월일시는 여전히
    /// 이 기계를 벗어나지 않습니다.
    public static func load(from data: Data) throws -> RuleSet {
        struct File: Codable { let version: Int; let rules: [Rule] }
        let decoded = try JSONDecoder().decode(File.self, from: data)
        return RuleSet(rules: decoded.rules, version: decoded.version)
    }

    /// 번들 리소스(rules.json) 로드. 맥 앱이 쓰는 길입니다.
    public static func bundled() throws -> RuleSet {
        guard let url = Bundle.module.url(forResource: "rules", withExtension: "json") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try load(from: Data(contentsOf: url))
    }

    public func matching(tag: String) -> [Rule] {
        byTag[tag] ?? []
    }

    public func matching(tags: [String]) -> [Rule] {
        var seen = Set<String>()
        var result: [Rule] = []
        for tag in tags {
            for rule in matching(tag: tag) where seen.insert(rule.id).inserted {
                result.append(rule)
            }
        }
        return result
    }
}

/// 해석 섹션 — 근거 룰이 부착된 구조화 출력.
public struct InterpretationSection: Sendable, Codable, Hashable, Identifiable {
    public let id: String
    public let title: String
    public let rules: [Rule]

    /// 이 섹션의 기준선 문장 — 근거 원문을 그대로 이은 것.
    ///
    /// 계산 결과의 일부다. 생성이 아니므로 시간도 배터리도 들지 않고,
    /// 모델이 없어도, 실패해도, 사용자가 중단해도 항상 이 자리에 있다.
    /// 앱에서 이 문장이 없는 화면은 존재하지 않는다.
    public var baselineText: String {
        rules.map(\.text).joined(separator: "\n\n")
    }
}

/// 섹션 컴포저 — 태그를 섹션별 룰 묶음으로.
public enum Composer {
    public static func sections(facts: FactSet, ruleSet: RuleSet) -> [InterpretationSection] {
        func tags(withPrefix prefixes: [String]) -> [String] {
            facts.tags.filter { tag in prefixes.contains { tag.hasPrefix($0 + ":") } }
        }
        let plan: [(id: String, title: String, prefixes: [String])] = [
            ("overview", "총평", ["ilgan", "strength"]),
            ("personality", "성격과 기질", ["sibsin"]),
            ("balance", "오행과 균형", ["oheng_excess", "oheng_lack", "wolji"]),
            ("flow", "흐름과 시기", ["daeun_sibsin", "sinsal"]),
        ]
        return plan.compactMap { section in
            let rules = ruleSet.matching(tags: tags(withPrefix: section.prefixes))
            guard !rules.isEmpty else { return nil }
            return InterpretationSection(id: section.id, title: section.title, rules: rules)
        }
    }
}
