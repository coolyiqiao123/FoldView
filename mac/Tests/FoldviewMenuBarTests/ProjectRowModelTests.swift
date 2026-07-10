import Foundation
import Testing
@testable import FoldviewMenuBar

struct ProjectRowModelTests {
    @Test func liveProjectShowsFilledDotAndPort() {
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "app", live: true, port: 5173, managed: true))
        #expect(row.statusSymbol == "●")
        #expect(row.statusText == "live :5173")
        #expect(row.canOpen)
        #expect(!row.canStart)
        #expect(row.canStop)
    }

    @Test func liveProjectWithoutKnownPortStillReadsLive() {
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "app", live: true, port: nil))
        #expect(row.statusText == "live")
    }

    @Test func readyProjectShowsHollowDot() {
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "app", live: false, launchable: true))
        #expect(row.statusSymbol == "○")
        #expect(row.statusText == "ready")
        #expect(row.canStart)
        #expect(!row.canOpen)
    }

    @Test func unlaunchableProjectShowsDash() {
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "app", live: false, launchable: false))
        #expect(row.statusSymbol == "—")
        #expect(row.statusText == "no dev server")
        #expect(!row.canStart)
        #expect(!row.canOpen)
    }

    @Test func stopOnlyOfferedWhenManagedAndLive() {
        let unmanaged = ProjectRowModel(payload: PayloadFixtures.project(name: "app", live: true, managed: false))
        #expect(!unmanaged.canStop)

        let managedButStopped = ProjectRowModel(payload: PayloadFixtures.project(name: "app", live: false, managed: true))
        #expect(!managedButStopped.canStop)

        let managedAndLive = ProjectRowModel(payload: PayloadFixtures.project(name: "app", live: true, managed: true))
        #expect(managedAndLive.canStop)
    }

    @Test func shortenedParentSubstitutesHomeDirectoryTilde() {
        let home = NSHomeDirectory()
        #expect(ProjectRowModel.shortenedParent(of: home + "/Projects/my-app") == "~/Projects")
        #expect(ProjectRowModel.shortenedParent(of: home + "/my-app") == "~")
        #expect(ProjectRowModel.shortenedParent(of: "/opt/other/my-app") == "/opt/other")
    }

    @Test func modifiedAtConvertsMillisecondEpochToDate() {
        let row = ProjectRowModel(payload: PayloadFixtures.project(name: "app", modifiedAt: 1782993600000))
        #expect(row.modifiedAt == Date(timeIntervalSince1970: 1782993600))
    }
}
