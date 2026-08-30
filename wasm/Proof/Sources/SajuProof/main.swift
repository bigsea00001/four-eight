import Foundation
import SajuKit

// 브라우저(wasm)가 명식 전체를 값으로 내는 것을 보이는 프로그램입니다.
// 입력은 인자로만 받습니다 — 인자를 통해 들어오는 UTF-8/UTF-16 함정을 브라우저에서도
// 밟는지 확인해야 하기 때문입니다.
//
// 인자: <연> <월> <일> <시|-> <분> <남|여> [rules.json경로] [양력|음력] [윤] [today=YYYY-MM-DD]
//   · 시가 "-"이면 시간 미상(삼주).
//   · 경로를 주면 그 바이트로 rules.json을 읽습니다(브라우저에서 fetch한 바이트).
//     안 주면 Bundle.module(맥 앱의 길)을 씁니다.
//   · 양력/음력, 윤달 여부는 선택.
//   · today=YYYY-MM-DD 를 주면 그 날짜 기준으로 오늘·이달·올해·대운(시간운)을 함께 냅니다.
//     오늘 날짜는 서버가 아니라 브라우저(new Date)가 넘깁니다. 안 주면 시간운은 안 냅니다.
// 출력: 한 줄 JSON. 브라우저에서든 리눅스에서든 stdout으로 같은 것이 나옵니다.

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 6,
      let year = Int(args[0]), let month = Int(args[1]), let day = Int(args[2]),
      let minute = Int(args[4])
else {
    fail("사용법: SajuProof <연> <월> <일> <시|-> <분> <남|여> [rules경로] [양력|음력] [윤] [today=YYYY-MM-DD]")
}
let hour: Int? = (args[3] == "-" || args[3].isEmpty) ? nil : Int(args[3])
let gender = Gender(rawValue: args[5]) ?? .male

// 달력 종류 — 6번째 인자 뒤(경로 다음)에서 찾되, 경로가 없을 수도 있으므로 값으로 판별.
let isLunar = args.contains("음력")
let isLeap = args.contains("윤")
let calendarType: BirthInput.CalendarType = isLunar ? .lunar(isLeapMonth: isLeap) : .solar

let input = BirthInput(
    year: year, month: month, day: day, hour: hour, minute: minute,
    calendarType: calendarType, gender: gender
)

let chart: SajuChart
do {
    chart = try PillarsEngine.chart(for: input)
} catch {
    fail("명식 계산 실패: \(error)")
}
let analysis = Analyzer.analyze(chart)

// 규칙 로드. 7번째 인자로 경로를 주면 그 바이트로(브라우저 경로), 없으면 번들에서(맥 경로).
var ruleSet: RuleSet? = nil
var rulesError: String? = nil
let rulesPath: String? = args.count >= 7 && !args[6].isEmpty
    && args[6] != "양력" && args[6] != "음력" && args[6] != "윤"
    && !args[6].hasPrefix("today=") ? args[6] : nil
do {
    if let rulesPath {
        ruleSet = try RuleSet.load(from: Data(contentsOf: URL(fileURLWithPath: rulesPath)))
    } else {
        ruleSet = try RuleSet.bundled()
    }
} catch {
    rulesError = "\(error)"
}

// 해석 섹션(근거 108룰 조립). 대운은 이 화면에서 다루지 않으므로 nil.
var sections: [ChartDTO.Section] = []
if let ruleSet {
    let facts = FactExtractor.facts(chart: chart, analysis: analysis, daeun: nil)
    sections = Composer.sections(facts: facts, ruleSet: ruleSet).map {
        ChartDTO.Section(title: $0.title, text: $0.baselineText)
    }
}

// MARK: - 출력 DTO

struct ChartDTO: Codable {
    struct Pillar: Codable {
        let position: String
        let ganjiKorean: String
        let ganjiHanja: String
        let stemKorean: String
        let stemHanja: String
        let stemElement: String
        let branchKorean: String
        let branchHanja: String
        let branchElement: String
        let tenGodStem: String?
        let tenGodBranch: String?
        let twelveStage: String?
    }
    struct Oheng: Codable {
        let element: String
        let hanja: String
        let count: Int
    }
    struct Section: Codable {
        let title: String
        let text: String
    }
    // 시간운(오늘·이달·올해·대운). today= 인자를 줄 때만 채워집니다.
    struct Cell: Codable {
        let ganjiKorean: String
        let ganjiHanja: String
        let stemKorean: String
        let stemHanja: String
        let stemElement: String
        let branchKorean: String
        let branchHanja: String
        let branchElement: String
    }
    struct Relation: Codable {
        let kind: String
        let position: String
        let display: String
    }
    struct Today: Codable {
        let date: String
        let cell: Cell
        let stemGod: String
        let branchGod: String
        let stage: String
        let isVoid: Bool
        let combinesDayMaster: Bool
        let relations: [Relation]
    }
    struct Period: Codable {
        let label: String
        let cell: Cell
        let stemGod: String
        let branchGod: String
    }
    struct DaeunPeriod: Codable {
        let index: Int
        let startAge: Int
        let startYear: Int
        let cell: Cell
        let stemGod: String
        let isCurrent: Bool
    }
    struct Daeun: Codable {
        let isForward: Bool
        let daeunSu: Int
        let ageYears: Int
        let currentIndex: Int?
        let periods: [DaeunPeriod]
    }
    struct TimeFortuneDTO: Codable {
        let today: Today
        let month: Period
        let year: Period
        let daeun: Daeun?
        let sections: [Section]
    }
    let inputLine: String
    let solarDate: String
    let lunarDate: String?
    let compactHanja: String
    let dayMasterKorean: String
    let dayMasterHanja: String
    let dayMasterElement: String
    let dayMasterYinYang: String
    let sajuYear: Int
    let governingJeol: String
    let solarTime: String
    let longitudeCorrectionMinutes: Double
    let equationOfTimeMinutes: Double
    let utcOffsetSeconds: Int
    let isDST: Bool
    let isNightJasi: Bool
    let pillars: [Pillar]
    let oheng: [Oheng]
    let strength: String
    let strengthPercent: Int
    let sinsal: [String]
    let voidPositions: [String]
    let relations: [String]
    let rulesVersion: Int?
    let rulesError: String?
    let sections: [Section]
    let time: TimeFortuneDTO?
}

func hhmm(_ secondsOfDay: Int) -> String {
    let s = ((secondsOfDay % 86400) + 86400) % 86400
    return String(format: "%02d:%02d", s / 3600, (s % 3600) / 60)
}

func cellOf(_ g: Ganji) -> ChartDTO.Cell {
    ChartDTO.Cell(
        ganjiKorean: g.korean,
        ganjiHanja: g.hanja,
        stemKorean: g.stem.korean,
        stemHanja: g.stem.hanja,
        stemElement: g.stem.element.korean,
        branchKorean: g.branch.korean,
        branchHanja: g.branch.hanja,
        branchElement: g.branch.element.korean
    )
}

let pillarDTOs: [ChartDTO.Pillar] = chart.pillars.map { pos, g in
    ChartDTO.Pillar(
        position: pos.rawValue,
        ganjiKorean: g.korean,
        ganjiHanja: g.hanja,
        stemKorean: g.stem.korean,
        stemHanja: g.stem.hanja,
        stemElement: g.stem.element.korean,
        branchKorean: g.branch.korean,
        branchHanja: g.branch.hanja,
        branchElement: g.branch.element.korean,
        tenGodStem: chart.tenGod(at: pos, stem: true)?.rawValue,
        tenGodBranch: chart.tenGod(at: pos, stem: false)?.rawValue,
        twelveStage: chart.twelveStage(at: pos)?.korean
    )
}

let ohengDTOs: [ChartDTO.Oheng] = Element.allCases.map {
    ChartDTO.Oheng(element: $0.korean, hanja: $0.hanja, count: analysis.elementCounts[$0] ?? 0)
}

// MARK: - 시간운 계산 (today= 인자가 있을 때만)
//
// SajuService.fortune / DaeUnTimelineView 가 화면에 쓰는 것과 같은 계산을
// 그대로 부릅니다. SajuKit 계산 코드는 읽어서 쓰기만 하고 고치지 않습니다.
// 오늘 날짜는 브라우저가 today=YYYY-MM-DD 로 넘깁니다. 서울(Asia/Seoul) 기준.

var timeDTO: ChartDTO.TimeFortuneDTO? = nil
let seoulTZ = TimeZone(identifier: "Asia/Seoul") ?? .current
if let todayArg = args.first(where: { $0.hasPrefix("today=") }) {
    let parts = todayArg.dropFirst("today=".count).split(separator: "-").compactMap { Int($0) }
    if parts.count == 3 {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = seoulTZ
        var comps = DateComponents()
        comps.year = parts[0]; comps.month = parts[1]; comps.day = parts[2]; comps.hour = 12
        if let today = cal.date(from: comps) {
            let master = chart.dayMaster

            // 오늘 — 일진.
            let dayReading = TimeFortune.day(today, chart: chart, timeZone: seoulTZ)
            let todayDTO = ChartDTO.Today(
                date: "\(parts[0])-\(parts[1])-\(parts[2])",
                cell: cellOf(dayReading.ganji),
                stemGod: dayReading.stemGod.korean,
                branchGod: dayReading.branchGod.korean,
                stage: dayReading.stage.korean,
                isVoid: dayReading.isVoid,
                combinesDayMaster: dayReading.combinesDayMaster,
                relations: dayReading.relations.map {
                    ChartDTO.Relation(kind: $0.kind.rawValue, position: $0.position.rawValue, display: $0.display)
                }
            )

            // 이달 — 월운.
            let monthReading = TimeFortune.month(containing: today, chart: chart)
            let monthDTO = ChartDTO.Period(
                label: monthReading.label,
                cell: cellOf(monthReading.ganji),
                stemGod: monthReading.stemGod.korean,
                branchGod: monthReading.branchGod.korean
            )

            // 올해 — 세운. 입춘 기준 사주 연도 (SajuService.fortune 과 동일).
            var sajuYear = cal.component(.year, from: today)
            if today < SolarTerms.instant(of: .ipchun, year: sajuYear) { sajuYear -= 1 }
            let yearReading = TimeFortune.year(sajuYear, chart: chart)
            let yearDTO = ChartDTO.Period(
                label: yearReading.label,
                cell: cellOf(yearReading.ganji),
                stemGod: yearReading.stemGod.korean,
                branchGod: yearReading.branchGod.korean
            )

            // 대운 — 10년 단위 흐름, 현재 대운 강조.
            var daeunDTO: ChartDTO.Daeun? = nil
            let age = FactExtractor.ageYears(chart: chart, at: today)
            if let daeun = DaeUnEngine.daeun(for: chart) {
                let currentIndex = daeun.current(ageYears: age)?.index
                let periods = daeun.periods.map { p -> ChartDTO.DaeunPeriod in
                    ChartDTO.DaeunPeriod(
                        index: p.index,
                        startAge: p.startAge,
                        startYear: p.startYear,
                        cell: cellOf(p.ganji),
                        stemGod: TenGod.of(dayMaster: master, target: p.ganji.stem).korean,
                        isCurrent: currentIndex == p.index
                    )
                }
                daeunDTO = ChartDTO.Daeun(
                    isForward: daeun.isForward,
                    daeunSu: daeun.daeunSu,
                    ageYears: age,
                    currentIndex: currentIndex,
                    periods: periods
                )
            }

            // 시간운 해석 섹션(오늘의 기운 / 이달과 올해). 근거 규칙에서 조립.
            var timeSecs: [ChartDTO.Section] = []
            if let ruleSet {
                let tf = TimeFactExtractor.facts(
                    day: dayReading, month: monthReading, year: yearReading, chart: chart
                )
                timeSecs = Composer.timeSections(facts: tf, ruleSet: ruleSet).map {
                    ChartDTO.Section(title: $0.title, text: $0.baselineText)
                }
            }

            timeDTO = ChartDTO.TimeFortuneDTO(
                today: todayDTO, month: monthDTO, year: yearDTO,
                daeun: daeunDTO, sections: timeSecs
            )
        }
    }
}

var inputLine = "\(year)-\(month)-\(day)"
if let hour { inputLine += String(format: " %02d:%02d", hour, minute) } else { inputLine += " 시간미상" }
inputLine += " \(gender.rawValue) \(isLunar ? "음력" : "양력")\(isLeap ? " 윤달" : "") 서울"

let dto = ChartDTO(
    inputLine: inputLine,
    solarDate: "\(chart.solarYear)-\(chart.solarMonth)-\(chart.solarDay)",
    lunarDate: chart.lunarDate?.description,
    compactHanja: chart.compactHanja,
    dayMasterKorean: chart.dayMaster.korean,
    dayMasterHanja: chart.dayMaster.hanja,
    dayMasterElement: chart.dayMaster.element.korean,
    dayMasterYinYang: chart.dayMaster.yinYang.korean,
    sajuYear: chart.sajuYear,
    governingJeol: chart.governingJeol.korean,
    solarTime: hhmm(chart.corrections.solarTimeSecondsOfDay),
    longitudeCorrectionMinutes: chart.corrections.longitudeCorrectionMinutes,
    equationOfTimeMinutes: chart.corrections.equationOfTimeMinutes,
    utcOffsetSeconds: chart.corrections.utcOffsetSeconds,
    isDST: chart.corrections.isDST,
    isNightJasi: chart.isNightJasi,
    pillars: pillarDTOs,
    oheng: ohengDTOs,
    strength: analysis.strength.rawValue,
    strengthPercent: Int((analysis.strengthRatio * 100).rounded()),
    sinsal: analysis.sinsalHits.map { "\($0.sinsal.rawValue)(\($0.position.rawValue))" },
    voidPositions: analysis.voidPositions.map { $0.rawValue },
    relations: analysis.relations.map { $0.display },
    rulesVersion: ruleSet?.version,
    rulesError: rulesError,
    sections: sections,
    time: timeDTO
)

let encoder = JSONEncoder()
let data = try encoder.encode(dto)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
