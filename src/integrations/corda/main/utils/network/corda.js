const { exec, spawn } = require("child_process");
const { join } = require("path");
const { ipcMain } = require("electron");
const node_ssh = require("node-ssh");
const StreamingMessageHandler = require("./streaming-message-handler");
const noop = () => {};

class Corda {
  constructor(entity, path, JAVA_HOME, io) {
    this.entity = entity;
    this.path = path;
    this.JAVA_HOME = JAVA_HOME;
    this.java = null;
    this._io = io;
    this.ssh = null;

    this.earlyCloseHandler = this.earlyCloseHandler.bind(this)

    this._dataHandler = new StreamingMessageHandler();
    this._dataHandler.addErrHandler("CAPSULE EXCEPTION: Capsule not extracted.", this.handleCapsuleError.bind(this));
    this._dataHandler.addOutHandler("Failed to bind on an address in ", this.handlePortBindError.bind(this));
    this._dataHandler.addOutHandler("Failed to bind on address ", this.handlePortBindError.bind(this));
    this._dataHandler.addOutHandler('" started up and registered in ', this.handleStartUp.bind(this))

    this._javaPath = join(this.JAVA_HOME, "bin", "java");
    this._args = ["-jar", join(this.path, "corda.jar"), "--no-local-shell", "--log-to-console"]
    this._opts = {
      cwd: this.path,
      env: null
    };

    if (process.platform === "win32") {
      // on Windows node can't seem to kill the grandchild process via java.kill,
      // it just orphans it :-/
      this.kill = () => exec(`taskkill /pid ${this.java.pid} /t /f`);
    } else {
      this.kill = () => this.java.kill();
    }

    this._awaiter = {resolve: noop, reject: noop};
  }

  status = "stopped";
  _startPromise = null;
  _stopPromise = null;

  async start() {
    // if we are currently stopping, wait for that to finish before attempting to start
    if (this.status === "stopping") await this._stopPromise;

    // if we are already started or currently starting return the existing promise
    if (this.status === "started" || this.status === "starting") return this._startPromise;

    return this._startPromise = new Promise((resolve, reject) => {
      this.status = "starting";
      this._stopPromise = null;
      this._awaiter = {resolve, reject};

      this.java = spawn(this._javaPath, this._args, this._opts);
      this._dataHandler.bind(this.java);
      //#region Logging
      /* eslint-disable no-console */
      this.java.stderr.on("data", (data) => {
        this._io.sendStdErr(data, this.entity.safeName);
        console.error(`corda stderr:\n${data}`);
      });
      this.java.stdout.on("data", (data) => {
        this._io.sendStdOut(data, this.entity.safeName);
        console.log(`corda stdout:\n${data}`);
      });
      this.java.on("error", console.error);
      /* eslint-enable no-console */
      //#endregion

      this.java.once("close", this.earlyCloseHandler);
    });
  }
  /**
   * Stops the running corda node. If corda is currently "starting" it will
   * wait for it to start up before shutting down.
   * @param {*} failedStartup set to `true` if stop should be called without waiting for startup.
   */
  async stop(failedStartup = false) {
    // if we are currently starting up, wait for that to finish before attempting to stop
    if (!failedStartup && this.status === "starting") {
      await this._startPromise
        // ignore startup errors because we want to stop things anyway
        .catch(e => e);
    }

    // don't stop again if we are "stopping" or "stopped" already
    if (this.status === "stopping" || this.status === "stopped") return this._stopPromise;

    // clean up bound std handlers
    this._dataHandler.unbind();
    this._startPromise = null;
    const java = this.java;

    // we weren't started in the first place, just return right away
    if (!java || java.exitCode !== null || java.signalCode !== null) {
      this.status = "stopped";
      this.java = null;
      this.ssh = null;
      return this._stopPromise = Promise.resolve();
    }

    this.status = "stopping";
    return this._stopPromise = new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(rejectTimeout);
        clearTimeout(killTimer);
        this.status = "stopped";
        this.java = null;
        this.ssh = null;
        resolve();
      };
      java.once("close", finish);

      let killTimer;
      // if it hasn't died after 30 seconds kill it with fire
      killTimer = setTimeout(this.kill.bind(this), 30000);
      const rejectTimeout = setTimeout(() => {
        // if we're in here this is REALLY bad. We couldn't stop corda after 120 seconds!
        java.off("close", finish);
        clearTimeout(killTimer);
        reject(new Error(`Couldn't stop corda process chain with PID ${java.pid}. This like means you'll need to end processes manual or restart your computer. Please report this issue!`));
      }, 120000);

      // if ssh has started and has a connection
      // use it to shutdown the node
      const ssh = this.ssh;
      if (ssh && ssh.connection) {
        ssh.connection.once("error", () => {
          // swallow the error
          // this shutdown command causes a disconnect from the corda
          // which results an error within the ssh connection logic.
        });
        ssh.exec("run", ["gracefulShutdown"]).catch(e => {
          // eslint-disable-next-line no-console
          console.error(e);
          // didn't seem to work... send SIGINT
          this.kill();
        });
      } else {
        // somehow we got here without an ssh connection, which is weird, but
        // technically possible if we DID have a connection that soon failed.
        // So... just try killing the process now.
        this.kill();
      }
    });
  }

  async earlyCloseHandler(code){
    // eslint-disable-next-line no-console
    console.log("corda", `child process exited with code ${code}`);
    const reject = this._awaiter.reject;

    await this.stop(true).catch(e => e);
    reject(new Error(`corda.jar child process exited with code ${code}`));
  }

  async handleStartUp() {
    const {resolve, reject} = this._awaiter;

    this._dataHandler.unbind();

    const ssh = new node_ssh();
    try {
      await ssh.connect({
        keepaliveInterval: 10000,
        host: "127.0.0.1",
        username: "user1",
        password: "letmein",
        port: this.entity.sshdPort
      })
      this.ssh = ssh;
      this.status = "started";
      const stream = await ssh.requestShell();
      ipcMain.on("xtermData", (_event, {node, data}) => {
        if (node !== this.entity.safeName) return;
        stream.write(data);
      });
      stream.on("data", data => {
        this._io.context.emit.call(this._io.context, "message", "sshData", {node: this.entity.safeName, data: data.toString("utf-8")});
      });
      resolve(ssh);
    } catch(e) {
      await this.stop(true);
      reject(e);
    }
  }

  async handleCapsuleError() {
    const resolve = this._awaiter.resolve;

    this.java.off("earlyCloseHandler", this.earlyCloseHandler);
    this.stop(true).then(async () => {
      this._io.sendStdErr("Recovering from CAPSULE EXCEPTION...", this.entity.safeName);
      const ssh = await this.start();
      resolve(ssh);
    });
    return true;
  }

  async handlePortBindError(data) {
    const reject = this._awaiter.reject;
    
    this.java.off("close", this.earlyCloseHandler);
    this.stop(true).then(() => {
      reject(new Error(data.toString().trim()));
    })
    return true;
  }
}

module.exports = Corda;
