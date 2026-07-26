import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var selectedTool: ToolKind = .codex
    @Published private(set) var modelsByTool: [ToolKind: [ModelOption]] = [:]
    @Published private(set) var defaultsByTool: [ToolKind: (model: String?, effort: String?)] = [:]
    @Published var selectedModelID: String = ""
    @Published var selectedEffort: String?
    @Published var workingDirectory: URL
    @Published var isLoading = false
    @Published var notice: AppNotice?

    private var selections: [ToolKind: (model: String, effort: String?)] = [:]

    init() {
        let storedPath = UserDefaults.standard.string(forKey: "workingDirectory")
        self.workingDirectory = storedPath.map(URL.init(fileURLWithPath:))
            ?? FileManager.default.homeDirectoryForCurrentUser
    }

    var models: [ModelOption] { modelsByTool[selectedTool] ?? [] }

    var selectedModel: ModelOption? {
        models.first(where: { $0.id == selectedModelID })
    }

    var efforts: [String] {
        selectedModel?.efforts ?? []
    }

    var modelIndex: Double {
        Double(models.firstIndex(where: { $0.id == selectedModelID }) ?? 0)
    }

    var effortIndex: Double {
        Double(efforts.firstIndex(of: selectedEffort ?? "") ?? 0)
    }

    var defaultSummary: String {
        let current = defaultsByTool[selectedTool]
        let currentModel = models.first(where: { $0.id == current?.model })
        let modelName = currentModel?.displayName ?? current?.model ?? "Not set"
        if let effort = current?.effort, !(currentModel?.efforts.isEmpty ?? true) {
            return "Default · \(modelName) · \(effort.capitalized)"
        }
        return "Default · \(modelName)"
    }

    func load() {
        guard !isLoading else { return }
        isLoading = true
        notice = nil
        Task {
            let result = await Task.detached(priority: .userInitiated) { () -> Result<[ToolKind: ToolSnapshot], Error> in
                do {
                    return .success([
                        .codex: try CatalogLoader.loadCodex(),
                        .kimi: try CatalogLoader.loadKimi()
                    ])
                } catch {
                    return .failure(error)
                }
            }.value

            isLoading = false
            switch result {
            case .success(let snapshots):
                for (tool, snapshot) in snapshots {
                    modelsByTool[tool] = snapshot.models
                    defaultsByTool[tool] = (snapshot.defaultModelID, snapshot.defaultEffort)
                    let fallbackModel = snapshot.models.first?.id ?? ""
                    let modelID = snapshot.models.contains(where: { $0.id == snapshot.defaultModelID })
                        ? (snapshot.defaultModelID ?? fallbackModel)
                        : fallbackModel
                    let option = snapshot.models.first(where: { $0.id == modelID })
                    let effort = validEffort(snapshot.defaultEffort, for: option)
                    selections[tool] = (modelID, effort)
                }
                restoreSelection(for: selectedTool)
            case .failure(let error):
                notice = AppNotice(text: error.localizedDescription, tone: .error)
            }
        }
    }

    func switchTool(to tool: ToolKind) {
        rememberCurrentSelection()
        selectedTool = tool
        restoreSelection(for: tool)
        notice = nil
    }

    func selectModel(at rawIndex: Int) {
        guard !models.isEmpty else { return }
        let index = min(max(rawIndex, 0), models.count - 1)
        let model = models[index]
        selectedModelID = model.id
        selectedEffort = validEffort(selectedEffort, for: model)
        rememberCurrentSelection()
        notice = nil
    }

    func selectEffort(at rawIndex: Int) {
        guard !efforts.isEmpty else { selectedEffort = nil; return }
        let index = min(max(rawIndex, 0), efforts.count - 1)
        selectedEffort = efforts[index]
        rememberCurrentSelection()
        notice = nil
    }

    func chooseWorkingDirectory() {
        let panel = NSOpenPanel()
        panel.title = "Choose a project folder"
        panel.prompt = "Choose"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = workingDirectory
        if panel.runModal() == .OK, let url = panel.url {
            workingDirectory = url
            UserDefaults.standard.set(url.path, forKey: "workingDirectory")
        }
    }

    func saveDefault() {
        guard !selectedModelID.isEmpty else {
            notice = AppNotice(text: ModelDialError.invalidSelection.localizedDescription, tone: .error)
            return
        }
        do {
            try CatalogLoader.saveDefault(tool: selectedTool, modelID: selectedModelID, effort: selectedEffort)
            defaultsByTool[selectedTool] = (selectedModelID, selectedEffort)
            notice = AppNotice(text: "Saved as the \(selectedTool.shortName) default.", tone: .success)
        } catch {
            notice = AppNotice(text: error.localizedDescription, tone: .error)
        }
    }

    func launch() {
        guard !selectedModelID.isEmpty else {
            notice = AppNotice(text: ModelDialError.invalidSelection.localizedDescription, tone: .error)
            return
        }
        do {
            try CatalogLoader.launch(
                tool: selectedTool,
                modelID: selectedModelID,
                effort: selectedEffort,
                directory: workingDirectory
            )
            notice = AppNotice(text: "Opened \(selectedTool.rawValue) in Terminal.", tone: .success)
        } catch {
            notice = AppNotice(text: error.localizedDescription, tone: .error)
        }
    }

    private func rememberCurrentSelection() {
        guard !selectedModelID.isEmpty else { return }
        selections[selectedTool] = (selectedModelID, selectedEffort)
    }

    private func restoreSelection(for tool: ToolKind) {
        let available = modelsByTool[tool] ?? []
        let stored = selections[tool]
        selectedModelID = available.contains(where: { $0.id == stored?.model })
            ? (stored?.model ?? "")
            : (available.first?.id ?? "")
        selectedEffort = validEffort(stored?.effort, for: available.first(where: { $0.id == selectedModelID }))
    }

    private func validEffort(_ requested: String?, for model: ModelOption?) -> String? {
        guard let model, !model.efforts.isEmpty else { return nil }
        if let requested, model.efforts.contains(requested) { return requested }
        if let defaultEffort = model.defaultEffort, model.efforts.contains(defaultEffort) { return defaultEffort }
        if model.efforts.contains("medium") { return "medium" }
        return model.efforts.first
    }
}
