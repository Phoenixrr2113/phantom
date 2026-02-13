import React, { useRef } from 'react';

export function InteractiveComponent() {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    const id = e.target.dataset.id;
    window.location.href = `/product/${id}`;
  };

  const handleFocus = () => {
    inputRef.current?.focus();
    document.body.classList.add('modal-open');
  };

  const handleScroll = () => {
    window.scrollTo(0, 0);
    localStorage.setItem('scrolled', 'true');
  };

  return (
    <div onClick={handleClick}>
      <input ref={inputRef} onFocus={handleFocus} />
      <button onClick={handleScroll}>Top</button>
    </div>
  );
}
