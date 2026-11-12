// Whether someone is unlocked with lines on their bill (POS spec §8): an app update waits until this is false, at lock
// or once the bill is cleared or finalized. Set by the counter screen; read by the service worker's update check.

let open = false;

export const isBillOpen = (): boolean => open;

export const setBillOpen = (value: boolean): void => {
  open = value;
};
