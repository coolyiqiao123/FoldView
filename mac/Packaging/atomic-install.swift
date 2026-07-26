import Darwin
import Foundation

private enum InstallError: Error, CustomStringConvertible {
    case usage
    case invalid(String)
    case system(String, Int32)

    var description: String {
        switch self {
        case .usage:
            return "usage: atomic-install <staged-app> <destination-app>"
        case .invalid(let message):
            return message
        case .system(let operation, let code):
            return "\(operation) failed: \(String(cString: strerror(code)))"
        }
    }
}

private func metadata(_ path: String) throws -> stat? {
    var value = stat()
    if lstat(path, &value) == 0 { return value }
    if errno == ENOENT { return nil }
    throw InstallError.system("lstat \(path)", errno)
}

private func physicalDirectory(_ path: String) throws -> String {
    guard let resolved = realpath(path, nil) else {
        throw InstallError.system("realpath \(path)", errno)
    }
    defer { free(resolved) }
    return String(cString: resolved)
}

private func run() throws {
    guard CommandLine.arguments.count == 3 else { throw InstallError.usage }
    let staged = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL.path
    let destination = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL.path
    guard staged != destination else { throw InstallError.invalid("staged app and destination must differ") }

    let stagedContainerURL = URL(fileURLWithPath: staged).deletingLastPathComponent()
    let stagedParent = try physicalDirectory(stagedContainerURL.path)
    let stagedParentOwner = try physicalDirectory(stagedContainerURL.deletingLastPathComponent().path)
    let destinationParent = try physicalDirectory(URL(fileURLWithPath: destination).deletingLastPathComponent().path)
    guard stagedParentOwner == destinationParent,
          stagedContainerURL.lastPathComponent.hasPrefix(".Foldview.install.") else {
        throw InstallError.invalid("staged app must be inside a unique staging directory under the destination parent")
    }
    guard let containerMetadata = try metadata(stagedParent),
          (containerMetadata.st_mode & S_IFMT) == S_IFDIR,
          containerMetadata.st_uid == geteuid(),
          (containerMetadata.st_mode & 0o077) == 0 else {
        throw InstallError.invalid("staging directory must be a private current-user-owned directory")
    }

    guard let stagedMetadata = try metadata(staged),
          (stagedMetadata.st_mode & S_IFMT) == S_IFDIR,
          stagedMetadata.st_uid == geteuid() else {
        throw InstallError.invalid("staged app must be a current-user-owned directory, not a symlink")
    }

    if let destinationMetadata = try metadata(destination) {
        guard (destinationMetadata.st_mode & S_IFMT) == S_IFDIR,
              destinationMetadata.st_uid == geteuid() else {
            throw InstallError.invalid("destination must be a current-user-owned directory, not a symlink")
        }
        let result = staged.withCString { stagedPath in
            destination.withCString { destinationPath in
                renameatx_np(AT_FDCWD, stagedPath, AT_FDCWD, destinationPath, UInt32(RENAME_SWAP))
            }
        }
        guard result == 0 else { throw InstallError.system("atomic bundle exchange", errno) }
    } else {
        let result = staged.withCString { stagedPath in
            destination.withCString { destinationPath in rename(stagedPath, destinationPath) }
        }
        guard result == 0 else { throw InstallError.system("atomic bundle install", errno) }
    }
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("Foldview atomic installer: \(error)\n".utf8))
    exit(1)
}
