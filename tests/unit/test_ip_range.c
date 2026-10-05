/**
 * @file test_ip_range.c
 * @brief Layer 1 tests for subnet-scan IP range validation (utils/ip_range)
 */

#include <stdio.h>
#include <string.h>

#include "unity.h"
#include "../../src/utils/ip_range.c"

static uint32_t first, last;
static char error[160];

void setUp(void) {
    first = last = 0;
    error[0] = '\0';
}

void tearDown(void) {}

static uint32_t ip(const char *text) {
    uint32_t a = 0, b = 0;
    TEST_ASSERT_EQUAL_INT(0, ip_range_parse(text, text, &a, &b, NULL, 0));
    return a;
}

void test_full_slash24_range_is_valid(void) {
    TEST_ASSERT_EQUAL_INT(0, ip_range_parse("172.16.3.1", "172.16.3.255", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_UINT32(0xAC100301u, first);
    TEST_ASSERT_EQUAL_UINT32(0xAC1003FFu, last);
}

void test_single_address_range_is_valid(void) {
    TEST_ASSERT_EQUAL_INT(0, ip_range_parse("172.16.3.1", "172.16.3.1", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_UINT32(first, last);
}

void test_invalid_address_is_rejected(void) {
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("172.16.3.300", "172.16.3.1", &first, &last, error, sizeof(error)));
    TEST_ASSERT_NOT_NULL(strstr(error, "Start IP"));
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("172.16.3.1", "not-an-ip", &first, &last, error, sizeof(error)));
    TEST_ASSERT_NOT_NULL(strstr(error, "End IP"));
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("", "172.16.3.1", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse(NULL, "172.16.3.1", &first, &last, error, sizeof(error)));
}

void test_start_greater_than_end_is_rejected(void) {
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("172.16.3.255", "172.16.3.1", &first, &last, error, sizeof(error)));
    TEST_ASSERT_NOT_NULL(strstr(error, "greater"));
}

void test_too_large_range_is_rejected(void) {
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("0.0.0.0", "255.255.255.255", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("10.0.0.0", "10.0.255.255", &first, &last, error, sizeof(error)));
    TEST_ASSERT_NOT_NULL(strstr(error, "too large"));
    // exactly the limit is fine
    TEST_ASSERT_EQUAL_INT(0, ip_range_parse("10.0.0.0", "10.0.3.255", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_UINT32(IP_RANGE_MAX_HOSTS, last - first + 1);
}

void test_public_addresses_are_rejected(void) {
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("8.8.8.1", "8.8.8.20", &first, &last, error, sizeof(error)));
    TEST_ASSERT_NOT_NULL(strstr(error, "private"));
    // 172.32.x is outside 172.16.0.0/12
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("172.32.0.1", "172.32.0.9", &first, &last, error, sizeof(error)));
    // loopback is not a LAN
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse("127.0.0.1", "127.0.0.5", &first, &last, error, sizeof(error)));
}

void test_private_lan_classification(void) {
    TEST_ASSERT_TRUE(ip_is_private_lan(ip("10.1.2.3")));
    TEST_ASSERT_TRUE(ip_is_private_lan(ip("172.16.0.1")));
    TEST_ASSERT_TRUE(ip_is_private_lan(ip("172.31.255.254")));
    TEST_ASSERT_TRUE(ip_is_private_lan(ip("192.168.1.1")));
    TEST_ASSERT_TRUE(ip_is_private_lan(ip("169.254.10.1")));
}

void test_cidr_excludes_network_and_broadcast(void) {
    TEST_ASSERT_EQUAL_INT(0, ip_range_parse_cidr("172.16.3.0/24", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_UINT32(0xAC100301u, first);
    TEST_ASSERT_EQUAL_UINT32(0xAC1003FEu, last);
    // host bits in the base address are ignored
    TEST_ASSERT_EQUAL_INT(0, ip_range_parse_cidr("192.168.1.77/30", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_UINT32(last - first + 1, 2);
}

void test_cidr_validation(void) {
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse_cidr("172.16.3.0", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse_cidr("172.16.3.0/33", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse_cidr("172.16.3.0/", &first, &last, error, sizeof(error)));
    TEST_ASSERT_EQUAL_INT(-1, ip_range_parse_cidr("10.0.0.0/8", &first, &last, error, sizeof(error)));
    TEST_ASSERT_NOT_NULL(strstr(error, "too large"));
}

void test_ip_to_string(void) {
    char buffer[16];
    ip_to_string(0xAC1003D7u, buffer, sizeof(buffer));
    TEST_ASSERT_EQUAL_STRING("172.16.3.215", buffer);
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_full_slash24_range_is_valid);
    RUN_TEST(test_single_address_range_is_valid);
    RUN_TEST(test_invalid_address_is_rejected);
    RUN_TEST(test_start_greater_than_end_is_rejected);
    RUN_TEST(test_too_large_range_is_rejected);
    RUN_TEST(test_public_addresses_are_rejected);
    RUN_TEST(test_private_lan_classification);
    RUN_TEST(test_cidr_excludes_network_and_broadcast);
    RUN_TEST(test_cidr_validation);
    RUN_TEST(test_ip_to_string);
    return UNITY_END();
}
