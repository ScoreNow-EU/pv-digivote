export interface TimecodeFrame {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  frameRate: number;
}

const LTC_PATTERN = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/;

export function parseTimecode(value: string, frameRate: number): TimecodeFrame {
  const match = LTC_PATTERN.exec(value);
  if (!match) throw new Error(`Ungültiger LTC-Wert: ${value}`);

  const [, hourText, minuteText, secondText, frameText] = match;
  const result: TimecodeFrame = {
    hours: Number(hourText),
    minutes: Number(minuteText),
    seconds: Number(secondText),
    frames: Number(frameText),
    frameRate
  };
  if (!Number.isInteger(frameRate) || frameRate <= 0) {
    throw new Error("Die Simulation unterstützt nur positive ganzzahlige Framerates.");
  }
  if (result.minutes > 59 || result.seconds > 59 || result.frames >= frameRate) {
    throw new Error(`LTC-Wert liegt außerhalb des Wertebereichs: ${value} @ ${frameRate} fps`);
  }
  return result;
}

export function formatTimecode(frame: TimecodeFrame): string {
  return [frame.hours, frame.minutes, frame.seconds, frame.frames]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function incrementTimecode(frame: TimecodeFrame): TimecodeFrame {
  let { hours, minutes, seconds, frames } = frame;
  frames += 1;
  if (frames >= frame.frameRate) {
    frames = 0;
    seconds += 1;
  }
  if (seconds >= 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes = 0;
    hours = (hours + 1) % 24;
  }
  return { hours, minutes, seconds, frames, frameRate: frame.frameRate };
}
