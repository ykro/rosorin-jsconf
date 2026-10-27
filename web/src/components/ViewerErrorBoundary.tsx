'use client';

import React from 'react';

interface ViewerErrorBoundaryProps {
  children: React.ReactNode;
}

interface ViewerErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a crash of the 3D scene (WebGL, STL loading, three.js) inside the
 * viewer area instead of replacing the whole page with "Application error".
 */
export class ViewerErrorBoundary extends React.Component<ViewerErrorBoundaryProps, ViewerErrorBoundaryState> {
  state: ViewerErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ViewerErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.warn('[3d] El simulador 3D falló; el resto de la página sigue activo:', error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const noWebgl = /webgl/i.test(error.message);
    return (
      <div
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#F1F3F4] p-6 text-center"
      >
        <p className="text-sm font-bold text-[#202124]">
          {noWebgl ? 'Sin WebGL: el simulador 3D no está disponible' : 'El simulador 3D falló'}
        </p>
        <p className="max-w-sm text-xs text-[#5F6368]">
          El resto de la página sigue funcionando: consola Live, botones del robot y STOP.
        </p>
        <button
          type="button"
          onClick={this.retry}
          className="rounded-lg border border-[#DADCE0] bg-[#F8F9FA] px-3 py-1.5 text-xs font-bold text-[#202124] hover:border-[#1A73E8]"
        >
          Reintentar
        </button>
      </div>
    );
  }
}
