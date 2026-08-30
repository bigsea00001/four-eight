// swift-tools-version:6.0
import PackageDescription

// wasm 증명용 실행 타깃입니다. SajuKit 자체를 건드리지 않으려고 별도 패키지로 두었습니다.
//
// platforms를 선언하지 않는 이유 — platforms는 애플 플랫폼의 최소 버전을 적는
// 자리일 뿐이고 wasm·리눅스 빌드에는 아무 영향이 없습니다. SajuKit의
// `.macOS(.v14) / .iOS(.v17)` 선언도 같은 이유로 손댈 필요가 없었습니다.
let package = Package(
    name: "SajuProof",
    products: [
        .executable(name: "SajuProof", targets: ["SajuProof"]),
    ],
    dependencies: [
        .package(path: "../../SajuKit"),
    ],
    targets: [
        .executableTarget(
            name: "SajuProof",
            dependencies: [.product(name: "SajuKit", package: "SajuKit")]
        ),
    ]
)
