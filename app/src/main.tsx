import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

type ErrorBoundaryState = {
  error: Error | null;
};

class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return renderErrorText(
        `Frontend render error:\n${this.state.error.message}\n\n${this.state.error.stack ?? ""}`,
      );
    }

    return this.props.children;
  }
}

function renderErrorText(message: string) {
  return (
    <div
      style={{
        padding: 24,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#7f1d1d",
        background: "#fef2f2",
        minHeight: "100vh",
        whiteSpace: "pre-wrap",
      }}
    >
      {message}
    </div>
  );
}

function mountFatalError(message: string) {
  const root = document.getElementById("root");
  if (!root) return;

  ReactDOM.createRoot(root).render(renderErrorText(message));
}

window.addEventListener("error", (event) => {
  mountFatalError(`Global error:\n${event.message}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason =
    event.reason instanceof Error ? event.reason.stack ?? event.reason.message : String(event.reason);
  mountFatalError(`Unhandled promise rejection:\n${reason}`);
});

async function bootstrap() {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Missing #root element in index.html");
  }

  const { default: App } = await import("./App");

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap().catch((error) => {
  const message =
    error instanceof Error ? error.stack ?? error.message : String(error);
  mountFatalError(`Bootstrap error:\n${message}`);
});
