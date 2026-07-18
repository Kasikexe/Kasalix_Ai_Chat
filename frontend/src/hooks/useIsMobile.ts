import { useState, useEffect } from 'react';

function checkMobile(): boolean {
  // Check for mobile user agents
  const ua = navigator.userAgent.toLowerCase();
  const mobileUa = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);

  // Check for touch capability and small screen
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const smallScreen = window.innerWidth < 768;

  // A device is considered mobile if it has a mobile UA or (touch + small screen)
  return mobileUa || (hasTouch && smallScreen);
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => checkMobile());

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(checkMobile());
    };

    window.addEventListener('resize', handleResize);
    // Re-check on orientation change as well
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  return isMobile;
}
