export const sessionStorageCapacity = () => ({
  workspace: { bytes: 8388608, files: 16 },
  principal: { bytes: 16777216, files: 32 },
  instance: { bytes: 33554432, files: 64 },
  freeDisk: { bytes: 67108864, files: 128, headroomBytes: 0, headroomFiles: 0 },
});
