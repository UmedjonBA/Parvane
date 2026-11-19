type CallVideoState = {
  hasCamera: boolean;
  isCameraOff?: boolean;
  isSharingScreen: boolean;
};

export function getIsCallVideoMuted({ hasCamera, isCameraOff, isSharingScreen }: CallVideoState) {
  return !isSharingScreen && (!hasCamera || Boolean(isCameraOff));
}
