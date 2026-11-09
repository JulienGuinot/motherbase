import crypto from 'crypto';

export const randomNumber = function (length: number) {
  let text = '';
  const digits = '0123456789';
  for (let i = 0; i < length; i++) {
    const digit = digits[crypto.randomInt(i === 0 ? 1 : 0, digits.length)];
    text += digit;
  }
  return Number(text);
};
