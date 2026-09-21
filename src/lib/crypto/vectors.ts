/**
 * Published known-answer vectors.
 *
 * These are the point of milestone M1. A primitive that round-trips against
 * itself proves only that it is self-consistent - it would pass just as happily
 * with the parameters swapped, the wrong curve, or a silently broken clamp.
 * Matching bytes that someone else published is what says we implemented the
 * actual algorithm.
 *
 * Sources, all reproducible from the linked documents:
 *   Ed25519  RFC 8032 section 7.1
 *   X25519   RFC 7748 sections 5.2 and 6.1
 *   HKDF     RFC 5869 appendix A (SHA-256 cases)
 *   AES-GCM  "The Galois/Counter Mode of Operation (GCM)", McGrath & Viega,
 *            test cases 13-16 (the AES-256 set), as referenced by NIST SP 800-38D
 *
 * Kept in a plain module rather than inline so the same bytes can be driven
 * through both the WebCrypto and the @noble backend.
 */

/** RFC 8032 section 7.1 - Ed25519 sign/verify. */
export const ED25519_VECTORS = [
  {
    name: "RFC 8032 TEST 1 (empty message)",
    secretKey: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    signature:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    name: "RFC 8032 TEST 2 (one byte)",
    secretKey: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "72",
    signature:
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    name: "RFC 8032 TEST 3 (two bytes)",
    secretKey: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    publicKey: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    message: "af82",
    signature:
      "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
  {
    name: "RFC 8032 TEST SHA(abc) (64-byte message)",
    secretKey: "833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42",
    publicKey: "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
    message:
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    signature:
      "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704",
  },
] as const

/** RFC 7748 section 6.1 - the Alice/Bob X25519 exchange. */
export const X25519_ECDH_VECTOR = {
  name: "RFC 7748 section 6.1",
  aliceSecretKey: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  alicePublicKey: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  bobSecretKey: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  bobPublicKey: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  sharedSecret: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
} as const

/**
 * RFC 7748 section 5.2 - raw scalar multiplication. The inputs are deliberately
 * not pre-clamped and the second u-coordinate has its high bit set, so these
 * catch a missing scalar clamp or a missing u-coordinate mask, which the
 * section 6.1 exchange above would not.
 */
export const X25519_SCALARMULT_VECTORS = [
  {
    name: "RFC 7748 section 5.2 vector 1",
    scalar: "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
    u: "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
    output: "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
  },
  {
    name: "RFC 7748 section 5.2 vector 2 (u high bit set)",
    scalar: "4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d",
    u: "e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493",
    output: "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
  },
] as const

/** RFC 5869 appendix A, test cases 1-3 (the SHA-256 ones). */
export const HKDF_SHA256_VECTORS = [
  {
    name: "RFC 5869 test case 1",
    ikm: "0b".repeat(22),
    salt: "000102030405060708090a0b0c",
    info: "f0f1f2f3f4f5f6f7f8f9",
    length: 42,
    okm: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
  },
  {
    name: "RFC 5869 test case 2 (long inputs, 82-byte output)",
    ikm: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f",
    salt: "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
    info: "b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
    length: 82,
    okm: "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87",
  },
  {
    name: "RFC 5869 test case 3 (empty salt and info)",
    ikm: "0b".repeat(22),
    salt: "",
    info: "",
    length: 42,
    okm: "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
  },
] as const

/**
 * GCM specification test cases 13-16, the AES-256 set. `ciphertext` here is the
 * bare ciphertext and `tag` the GCM tag; our AEAD returns them concatenated,
 * which is how WebCrypto represents a GCM result.
 */
export const AES_256_GCM_VECTORS = [
  {
    name: "GCM test case 13 (empty plaintext)",
    key: "00".repeat(32),
    nonce: "00".repeat(12),
    aad: "",
    plaintext: "",
    ciphertext: "",
    tag: "530f8afbc74536b9a963b4f1c4cb738b",
  },
  {
    name: "GCM test case 14 (one zero block)",
    key: "00".repeat(32),
    nonce: "00".repeat(12),
    aad: "",
    plaintext: "00".repeat(16),
    ciphertext: "cea7403d4d606b6e074ec5d3baf39d18",
    tag: "d0d1c8a799996bf0265b98b5d48ab919",
  },
  {
    name: "GCM test case 15 (64-byte plaintext, no aad)",
    key: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
    nonce: "cafebabefacedbaddecaf888",
    aad: "",
    plaintext:
      "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255",
    ciphertext:
      "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad",
    tag: "b094dac5d93471bdec1a502270e3cc6c",
  },
  {
    name: "GCM test case 16 (60-byte plaintext with aad)",
    key: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
    nonce: "cafebabefacedbaddecaf888",
    aad: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
    plaintext:
      "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
    ciphertext:
      "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
    tag: "76fc6ece0f4e1768cddf8853bb2d551b",
  },
] as const
