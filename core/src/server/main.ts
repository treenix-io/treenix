// Select the runtime before legacy imports can load environment files or register handlers.
export {};

if (process.env.TREENIX_KERNEL === "1") {
  await import("#server/native-main");
} else {
  await import("#server/legacy-main");
}
