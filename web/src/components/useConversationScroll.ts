import { useLayoutEffect, useRef, useState } from 'react'

/** Follow the conversation until the reader scrolls away from the bottom. */
export function useConversationScroll(id: string, ready: boolean, content: unknown) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)

  // Reset before following the new session, including when its view appears later.
  useLayoutEffect(() => {
    stick.current = true
    setShowJump(false)
    const element = scroller.current
    if (!element) return
    const follow = () => {
      if (stick.current) element.scrollTop = element.scrollHeight
    }
    follow()
    // Images, text reflow and mobile viewport changes can resize after rendering.
    const observer = new ResizeObserver(follow)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [id, ready])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && stick.current) element.scrollTop = element.scrollHeight
  }, [content, ready])

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
    stick.current = atBottom
    setShowJump(!atBottom)
  }
  return { scroller, stick, showJump, onScroll }
}
