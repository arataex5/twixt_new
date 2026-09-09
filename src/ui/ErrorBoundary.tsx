import { Component, type ErrorInfo, type ReactNode } from "react";

interface State { error: Error | null; info: string }

/** 画面が真っ黒になる代わりに、エラー内容と再読み込みボタンを出す */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? "" });
    console.error("ErrorBoundary", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const text = `${this.state.error.name}: ${this.state.error.message}\n${this.state.error.stack ?? ""}\n${this.state.info}`;
    return (
      <div className="screen">
        <h2>エラーが発生しました</h2>
        <p className="muted small">この内容をコピーして報告してください。</p>
        <code className="errbox">{text}</code>
        <div className="controls">
          <button onClick={() => navigator.clipboard?.writeText(text)}>コピー</button>
          <button className="primary" onClick={() => location.reload()}>再読み込み</button>
        </div>
      </div>
    );
  }
}
