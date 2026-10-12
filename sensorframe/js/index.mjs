import sf from './index.js';

export const {
  createCodec, FrameStream, SensorFrameError, crc16, cobsEncode, cobsDecode, frameBytes,
  VERSION, HEADER_SIZE, CRC_SIZE, MIN_PACKET, MAX_PACKET, FMT, MSG_TYPE, RESERVED_TAGS,
} = sf;
export default sf;
