/**
 * Home.tsx — the page that hosts the game canvas.
 * All UI (HUD, menus, tutorial) is drawn on the canvas by the game itself;
 * the DOM shell only provides the fullscreen canvas.
 */

import { useEffect, useRef } from 'react'
import { startGame, stopGame } from '@/game/boot'

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    startGame(canvas)
    return () => stopGame()
  }, [])

  return (
    <div id="game-root">
      <canvas id="game-canvas" ref={canvasRef} />
    </div>
  )
}
