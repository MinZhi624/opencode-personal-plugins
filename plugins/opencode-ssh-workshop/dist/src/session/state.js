export function createState() {
    return {
        proc: null,
        host: null,
        connectedAt: null,
        buffer: "",
        stderr: "",
        pendingResolve: null,
        pendingReject: null,
        currentMarkerId: "",
        running: false,
        commandQueue: [],
        readerDone: false,
        deviceID: null,
        options: null,
        initialDirectory: null,
        remoteDirectory: null,
    };
}
