import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { createAttentionBellWav } from './attentionTone';

export class AttentionSound implements vscode.Disposable {
  private readonly players = new Set<ChildProcess>();
  private unavailableWarningShown = false;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async play(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(
      'lookout.attentionSound'
    );
    const enabled = configuration.get('enabled', true);
    const volume = Math.round(
      Math.max(0, Math.min(100, configuration.get('volume', 35)))
    );
    if (!enabled || volume === 0) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const soundUri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      `attention-bell-${volume}.wav`
    );
    try {
      await vscode.workspace.fs.stat(soundUri);
    } catch {
      await vscode.workspace.fs.writeFile(
        soundUri,
        createAttentionBellWav(volume)
      );
    }
    const played = await this.playFile(soundUri.fsPath);
    if (!played && !this.unavailableWarningShown) {
      this.unavailableWarningShown = true;
      void vscode.window.showWarningMessage(
        'Lookout attention sound is enabled, but no supported local audio player was found.'
      );
    }
  }

  public async toggle(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(
      'lookout.attentionSound'
    );
    const enabled = configuration.get('enabled', true);
    await configuration.update(
      'enabled',
      !enabled,
      vscode.ConfigurationTarget.Global
    );
    const volume = configuration.get('volume', 35);
    void vscode.window.showInformationMessage(
      enabled
        ? 'Lookout attention sound muted.'
        : `Lookout attention sound enabled at ${volume}%.`
    );
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(
      'lookout.attentionSound'
    );
    await configuration.update(
      'enabled',
      enabled,
      vscode.ConfigurationTarget.Global
    );
    const volume = configuration.get('volume', 35);
    void vscode.window.showInformationMessage(
      enabled
        ? `Lookout attention sound enabled at ${volume}%.`
        : 'Lookout attention sound muted.'
    );
  }

  public dispose(): void {
    for (const player of this.players) {
      player.kill();
    }
    this.players.clear();
  }

  private async playFile(filePath: string): Promise<boolean> {
    if (process.platform === 'darwin') {
      return this.run('afplay', [filePath]);
    }
    if (process.platform === 'win32') {
      return this.runPowerShell(filePath);
    }
    for (const [command, args] of [
      ['paplay', [filePath]],
      ['pw-play', [filePath]],
      ['aplay', ['-q', filePath]]
    ] as const) {
      if (await this.run(command, args)) {
        return true;
      }
    }
    if (process.env.WSL_DISTRO_NAME) {
      const windowsPath = await toWindowsPath(filePath);
      if (windowsPath) {
        return this.runPowerShell(windowsPath, 'powershell.exe');
      }
    }
    return false;
  }

  private runPowerShell(
    filePath: string,
    executable = 'powershell.exe'
  ): Promise<boolean> {
    const escapedPath = filePath.replace(/'/g, "''");
    return this.run(executable, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(New-Object System.Media.SoundPlayer '${escapedPath}').PlaySync()`
    ]);
  }

  private run(command: string, args: readonly string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        cwd: this.context.globalStorageUri.fsPath,
        stdio: 'ignore',
        windowsHide: true
      });
      this.players.add(child);
      let settled = false;
      const finish = (success: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.players.delete(child);
        resolve(success);
      };
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    });
  }
}

function toWindowsPath(filePath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('wslpath', ['-w', filePath], { encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? undefined : String(stdout).trim() || undefined);
    });
  });
}
