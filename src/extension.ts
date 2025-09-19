import * as vscode from 'vscode';
import { LogProvider } from './logProvider';

export function activate(context: any): void {
	const provider = new LogProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('logViewer.view', provider, {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.commands.registerCommand('logViewer.openFolder', async () => {
			await provider.handleOpenFolder();
		})
	);
}

export function deactivate(): void {
}

