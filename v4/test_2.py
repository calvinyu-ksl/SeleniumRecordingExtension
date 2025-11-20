from seleniumbase import BaseCase
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys
import time
BaseCase.main(__name__, __file__)

class _192_168_8_127(BaseCase):

    # --- Custom helper functions for dynamic elements ---
    def wait_for_scroll_and_enable(self, scroll_selector, checkbox_selector, timeout=30):
        """Scroll to bottom of an element and wait for checkbox to be enabled."""
        print(f"[SCROLL-ENABLE] Scrolling to bottom of {scroll_selector} and waiting for {checkbox_selector} to be enabled")
        
        # First ensure the scroll area is visible
        try:
            self.wait_for_element_present(scroll_selector, timeout=5)
            self.scroll_to(scroll_selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_present(scroll_selector, timeout=10)
        
        # Scroll to bottom of the scroll area using JavaScript
        scroll_script = """
        var scrollArea = arguments[0];
        if (scrollArea) {
            scrollArea.scrollTop = scrollArea.scrollHeight;
            return scrollArea.scrollTop;
        }
        return 0;
        """
        
        scroll_element = self.find_element(scroll_selector)
        scroll_position = self.execute_script(scroll_script, scroll_element)
        print(f"[SCROLL-ENABLE] Scrolled to position: {scroll_position}")
        
        # Wait for checkbox to become enabled
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                checkbox = self.find_element(checkbox_selector)
                if not checkbox.get_attribute('disabled'):
                    print(f"[SCROLL-ENABLE] Checkbox is now enabled")
                    return True
            except Exception as e:
                pass
            time.sleep(0.5)
        
        print(f"[SCROLL-ENABLE] Timeout waiting for checkbox to be enabled")
        return False

    def wait_for_attribute_not_value(self, selector, attribute, value=None, timeout=10):
        """Wait for an element's attribute to not have a specific value (or not exist)."""
        if value is None:
            # Wait for attribute to not exist (like disabled)
            start_time = time.time()
            while time.time() - start_time < timeout:
                try:
                    element = self.find_element(selector)
                    if not element.get_attribute(attribute):
                        return True
                except Exception:
                    pass
                time.sleep(0.1)
        else:
            # Wait for attribute to not have specific value
            start_time = time.time()
            while time.time() - start_time < timeout:
                try:
                    element = self.find_element(selector)
                    if element.get_attribute(attribute) != value:
                        return True
                except Exception:
                    pass
                time.sleep(0.1)
        return False

    def findWorkingSelector(self, selector_list):
        for i, selector in enumerate(selector_list, start=1):
            try:
                self.wait_for_element_present(selector, timeout=2)
                return selector
            except Exception as e:
                if i == len(selector_list):
                    raise 
                continue

    def test_recorded_script(self):
        # --- Test Actions ---
        self.open("http://192.168.8.127:443/ecmis-uat/index.html#/login")
        # Try multiple selectors to find a working one
        selector_list = ['#loginID', '//*[@id="loginID"]', '/html/body/div/div/div[2]/div/div[2]/div/div/form/div[1]/div/div[2]/div/div/input']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 1 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['//*[@id="loginID"]']
        selector = self.findWorkingSelector(selector_list)
        
        self.wait_for_element_present(selector, timeout=10)
        try:
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails

        self.send_keys(selector, 'psu-officer1')
        self.sleep(1)
        print(f'Step 2 - Input | Value: "psu-officer1"')

        # Try multiple selectors to find a working one
        selector_list = ['#loginPassword', '//*[@id="loginPassword"]', '/html/body/div/div/div[2]/div/div[2]/div/div/form/div[2]/div/div[2]/div/div/span/input']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 3 - Click')

        # Hover action - wait for element before hovering
        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div/div/div[2]/div/div[2]/div/div/form/button']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
            self.hover(selector)
        except Exception as e:
            print(f"Hover action skipped for {selector}: {e}")
        self.sleep(1)
        print(f'Step 4 - Hover | Value: "Hovered on <button>"')

        # Try multiple selectors to find a working one
        selector_list = ['//*[@id="loginPassword"]']
        selector = self.findWorkingSelector(selector_list)
        
        self.wait_for_element_present(selector, timeout=10)
        try:
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.click(selector)
        self.send_keys(selector, '321321')
        self.sleep(1)
        print(f'Step 5 - Input | Value: "321321"')

        # Try multiple selectors to find a working one
        selector_list = ['button.ant-btn.ant-btn-primary', '/html/body/div/div/div[2]/div/div[2]/div/div/form/button']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 6 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[3]/div/div[2]/div/div[2]/div/div/div[2]/button[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 7 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['button.ant-btn.ant-btn-default.ant-dropdown-trigger.drop_button.false.ant-dropdown-open', '/html/body/div[1]/section/header/div[2]/div[2]/button[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 8 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['li.ant-dropdown-menu-submenu.ant-dropdown-menu-submenu-vertical.ant-dropdown-menu-submenu-open.ant-dropdown-menu-submenu-active', '/html/body/div[3]/div/div/ul/li[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 9 - Click')

        # Hover action - wait for element before hovering
        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[4]/div/div/ul/li[4]/span/a']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
            self.hover(selector)
        except Exception as e:
            print(f"Hover action skipped for {selector}: {e}")
        self.sleep(1)
        print(f'Step 10 - Hover | Value: "Hovered on <a>"')

        # Try multiple selectors to find a working one
        selector_list = ['li.ant-dropdown-menu-item.ant-dropdown-menu-item-active.ant-dropdown-menu-item-only-child', '/html/body/div[4]/div/div/ul/li[4]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 11 - Click')

        # Hover action - wait for element before hovering
        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[2]/div/div[2]/div/div/div/form/div/div[6]/div/div/div[2]/div/div/div/div/span[1]/input']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
            self.hover(selector)
        except Exception as e:
            print(f"Hover action skipped for {selector}: {e}")
        self.sleep(1)
        print(f'Step 12 - Hover | Value: "Hovered on <input>"')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[3]/div/div/div[1]/div/a/button']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 13 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['#rc_select_3', '//*[@id="rc_select_3"]', '/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[2]/div/div[2]/div/div/div/form/div/div[2]/div/div/div[2]/div/div/div/div/span[1]/input']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 14 - Click')

        # Hover action - wait for element before hovering
        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[2]/div/div[2]/div/div/div/form/div/div[2]/div/div/div[2]/div/div/div/div/span[1]/input']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
            self.hover(selector)
        except Exception as e:
            print(f"Hover action skipped for {selector}: {e}")
        self.sleep(1)
        print(f'Step 15 - Hover | Value: "Hovered on <input>"')

        # Try multiple selectors to find a working one
        selector_list = ['#rc_select_3', '//*[@id="rc_select_3"]', '/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[2]/div/div[2]/div/div/div/form/div/div[2]/div/div/div[2]/div/div/div/div/span[1]/input']
        selector = self.findWorkingSelector(selector_list)
        
        self.wait_for_element_present(selector, timeout=10)
        try:
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.click(selector)
        self.send_keys(selector, 'C00900')
        self.sleep(1)
        print(f'Step 16 - Input | Value: "C00900"')

        # Try multiple selectors to find a working one
        selector_list = ['div.ant-row.ant-row-start.ant-row-middle', '/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[2]/div/div[2]/div/div/div/form/div']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 17 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['button.ant-btn.ant-btn-primary.btn_left', '/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[2]/div/div[2]/div/div/div/form/div/div[6]/div/button[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 18 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[3]/div/div/div/div/div[1]/div[2]/div/div/div/div/div/div/div/table/tbody/tr/td[1]/label/span/input']
        selector = self.findWorkingSelector(selector_list)
        
        print(f"[DEBUG Step 19] Found selector: {selector}")
        
        # Adjust selector for custom checkbox (Ant Design, etc.)
        import re
        if selector.startswith('/') and re.search(r'/input(\[\d+\])?$', selector):
            checkboxSelector = re.sub(r'/input(\[\d+\])?$', '', selector)
        else:
            checkboxSelector = selector
        
        print(f"[DEBUG Step 19] Checkbox selector after adjustment: {checkboxSelector}")
        
        try:
            self.wait_for_element_present(checkboxSelector, timeout=5)
            self.scroll_to(checkboxSelector)
            print(f"[DEBUG Step 19] Successfully scrolled to element")
        except Exception as e:
            print(f"[DEBUG Step 19] Scroll failed: {e}")
            pass  # Continue even if scroll fails
        
        # Wait for checkbox to be enabled (handle dynamic checkboxes)
        self.wait_for_element_present(checkboxSelector, timeout=10)
        self.wait_for_element_clickable(checkboxSelector, timeout=30)
        print(f"[DEBUG Step 19] Element is clickable")
        
        # Custom checkbox component detected (e.g., Ant Design)
        # Using JavaScript to check current state and click parent if needed
        target_checked = True
        try:
            # Get current checkbox state via JavaScript (input is hidden)
            current_checked = self.execute_script(
                f"return document.evaluate('{selector}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.checked"
            )
            print(f"[DEBUG Step 19] Current checked state: {current_checked}, Target: {target_checked}")
            if current_checked != target_checked:
                # Click the visible parent element to toggle
                print(f"[DEBUG Step 19] Using js_click on: {checkboxSelector}")
                self.js_click(checkboxSelector)
                print(f"[DEBUG Step 19] js_click executed")
                # Wait a moment for the state to update
                self.sleep(0.5)
                # Verify the state changed
                try:
                    new_checked = self.execute_script(
                        f"return document.evaluate('{selector}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.checked"
                    )
                    print(f"[DEBUG Step 19] After click, checked state: {new_checked}")
                    if new_checked != target_checked:
                        print(f"[DEBUG Step 19] State didn't change, trying regular click")
                        self.click(checkboxSelector)
                        self.sleep(0.5)
                        final_checked = self.execute_script(
                            f"return document.evaluate('{selector}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.checked"
                        )
                        print(f"[DEBUG Step 19] After regular click, checked state: {final_checked}")
                except Exception as e2:
                    print(f"[DEBUG Step 19] Could not verify state change: {e2}")
            else:
                print(f"[DEBUG Step 19] Checkbox already in desired state, no action needed")
        except Exception as e:
            # If JavaScript fails, try direct click on parent
            print(f"[DEBUG Step 19] JavaScript failed: {e}, trying direct click")
            self.click(checkboxSelector)
            print(f"[DEBUG Step 19] Direct click executed")
        self.sleep(1)
        print(f'Step 19 - Checkbox | Value: "true"')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[3]/div/div/div/div/div[2]/button[1]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 20 - Click')

        # Hover action - wait for element before hovering
        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[3]/div/div/div/div/div[1]/div[2]/div/div/div/div/div/div/div/table/thead/tr/th[1]/div/label/span/input']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
            self.hover(selector)
        except Exception as e:
            print(f"Hover action skipped for {selector}: {e}")
        self.sleep(1)
        print(f'Step 21 - Hover | Value: "Hovered on <button>"')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[3]/div/div/div/div/div[3]/div[3]/div/button[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 22 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/main/div/div/div[2]/div[1]/div/div/div/div[3]/div/div/div[2]/div/div/div/div/div/div/div/div/div/table/tbody/tr[2]/td[9]/div/button[1]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 23 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['button.ant-btn.ant-btn-primary.psu_officer_approver', '/html/body/div[3]/div/div[2]/div/div[2]/div[3]/div/div/div[2]/div/div/button']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 24 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['#assign_apprBy', '//*[@id="assign_apprBy"]', '/html/body/div[5]/div[2]/div/div[2]/div[2]/div/div/form/div/div/div/div/div/div/div/div[2]/div/div/div/div[1]/span[1]/input']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 25 - Click')

        # Hover action - wait for element before hovering
        # Try multiple selectors to find a working one
         # Try multiple selectors to find a working one
        selector_list = ['#assign_apprBy', '//*[@id="assign_apprBy"]', '/html/body/div[5]/div[2]/div/div[2]/div[2]/div/div/form/div/div/div/div/div/div/div/div[2]/div/div/div/div[1]/span[1]/input']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        '''self.click('#assign_apprBy')'''
        self.sleep(1)
        print(f'Step 2 - Click')

        # Try multiple selectors to find a working one
        
        
        # Ant Design Select uses virtual scrolling - need real mouse scroll
        selector_list = ["//*[contains(@class, 'ant-select-item') and normalize-space(text())='psu approver1']", "//*[contains(@class, 'ant-select-item') and @title='psu approver1']"]
        
        # Ant Design Select uses virtual scrolling - need real mouse scroll
        selector = None
        try:
            # Wait for dropdown to appear (animation may take time)
            print("[DEBUG] Waiting for dropdown...")
            self.wait_for_element_present('div.ant-select-dropdown:not(.ant-select-dropdown-hidden)', timeout=3)
            self.sleep(0.5)  # Wait for dropdown animation to complete
            print("[DEBUG] Dropdown appeared")
            
            # Find the actual scrollable container (rc-virtual-list-holder)
            try:
                scroll_container = self.find_element('div.rc-virtual-list-holder')
                print("[DEBUG] Found rc-virtual-list-holder")
            except:
                scroll_container = self.find_element('div.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
                print("[DEBUG] Using ant-select-dropdown as fallback")
            
            # Move mouse to scroll container first
            from selenium.webdriver.common.action_chains import ActionChains
            actions = ActionChains(self.driver)
            actions.move_to_element(scroll_container).perform()
            self.sleep(0.2)
            print("[DEBUG] Moved mouse to scroll container")
            
            # Scroll down multiple times to find the option
            max_attempts = 20
            for attempt in range(max_attempts):
                # Check if any selector is present
                for sel in selector_list:
                    try:
                        self.wait_for_element_present(sel, timeout=0.3)
                        selector = sel  # Remember the working selector
                        print(f"[DEBUG] Found selector on attempt {attempt + 1}: {sel[:60]}")
                        break  # Selector found, exit inner loop
                    except Exception:
                        continue
                if selector:
                    break  # Option found, exit outer loop
                
                # Scroll using multiple methods to ensure it works
                # Method 1: Direct scrollTop
                current_scroll = self.execute_script("return arguments[0].scrollTop", scroll_container)
                self.execute_script("arguments[0].scrollTop = arguments[0].scrollTop + 80", scroll_container)
                new_scroll = self.execute_script("return arguments[0].scrollTop", scroll_container)
                print(f"[DEBUG] Attempt {attempt + 1}: Scroll {current_scroll} -> {new_scroll}")
                self.sleep(0.1)
                
                # Method 2: ScrollBy for smooth scrolling
                self.execute_script("arguments[0].scrollBy(0, 80)", scroll_container)
                self.sleep(0.1)
        except Exception as e:
            print(f"[DEBUG] Virtual scroll failed: {e}")
            import traceback
            traceback.print_exc()
            pass  # Continue even if scroll fails
        
        # If virtual scrolling didn't find it, fall back to findWorkingSelector
        if not selector:
            print("[DEBUG] Virtual scroll didn't find selector, using findWorkingSelector")
            selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        '''self.click("//*[contains(@class, 'ant-select-item') and normalize-space(text())='psu approver1']")'''
        self.sleep(1)
        print(f'Step 3 - Click')
        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[5]/div[2]/div/div[2]/div[3]/button[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 28 - Click')

        # Hover action - wait for element before hovering
        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[6]/div/div[2]/div/div[2]/div/div/div[2]/button[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
            self.hover(selector)
        except Exception as e:
            print(f"Hover action skipped for {selector}: {e}")
        self.sleep(1)
        print(f'Step 29 - Hover | Value: "Hovered on <button>"')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[6]/div/div[2]/div/div[2]/div/div/div[2]/button[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 30 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[1]/section/header/div[2]/div[3]/div/div[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 31 - Click')

        # Try multiple selectors to find a working one
        selector_list = ['/html/body/div[7]/div/div[2]/div/div[2]/div/div/div[2]/button[2]']
        selector = self.findWorkingSelector(selector_list)
        
        try:
            self.wait_for_element_present(selector, timeout=5)
            self.scroll_to(selector)
        except Exception:
            pass  # Continue even if scroll fails
        self.wait_for_element_clickable(selector, timeout=10)
        self.click(selector)
        self.sleep(1)
        print(f'Step 32 - Click')


        print("\n*** Test script complete! ***")
