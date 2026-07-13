const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('appoly.lookout');
  if (!extension) {
    throw new Error('Installed extension appoly.lookout was not discovered');
  }
  await extension.activate();
  if (!extension.isActive) {
    throw new Error('Installed extension appoly.lookout did not activate');
  }
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'lookout.runDoctor',
    'lookout.launchAgent',
    'lookout.focusNextAttention'
  ]) {
    if (!commands.has(command)) {
      throw new Error(`Installed extension did not register ${command}`);
    }
  }
  await vscode.commands.executeCommand('lookout.runDoctor');
  console.log('Activated installed VSIX and ran Lookout: Run Doctor');
}

module.exports = { run };
