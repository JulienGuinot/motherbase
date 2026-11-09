'use client'
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'

interface FadeInProps {
  children: ReactNode
  delay?: number
  style?: CSSProperties
  className?: string
}

export default function FadeIn({ children, delay = 0, style, className }: FadeInProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.style.animationDelay = `${delay}ms`
          el.classList.add('anim-fade-up')
          io.unobserve(el)
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -48px 0px' },
    )

    io.observe(el)
    return () => io.disconnect()
  }, [delay])

  return (
    // Visible by default: the observer only *adds* the animation, so content
    // stays readable if JS or IntersectionObserver never runs.
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  )
}
